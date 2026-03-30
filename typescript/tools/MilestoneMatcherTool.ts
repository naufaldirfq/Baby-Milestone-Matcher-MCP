import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { differenceInMonths, parseISO } from "date-fns";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";
import * as fs from "fs";
import * as path from "path";

// Load CDC Data
const cdcDataPath = path.join(__dirname, "../milestones/cdc_data.json");
const cdcData = JSON.parse(fs.readFileSync(cdcDataPath, "utf-8"));

// ---------- helpers ----------

/** Conditions that affect developmental milestone expectations */
const DEVELOPMENTAL_CONDITIONS: Record<string, string> = {
  premature: "Prematurity — applying corrected age (−2 months).",
  preterm: "Prematurity — applying corrected age (−2 months).",
  "down syndrome": "Down Syndrome — milestones may follow an alternate timeline.",
  "trisomy 21": "Down Syndrome — milestones may follow an alternate timeline.",
  "cerebral palsy": "Cerebral Palsy — gross/fine motor milestones may be delayed.",
  "autism": "Autism Spectrum — social/communication milestones may differ.",
};

/**
 * Fuzzy keyword match: checks if an observed behavior text is close enough
 * to an expected milestone string.  Works by checking if every significant
 * keyword in the milestone appears somewhere in the observation (or vice-versa).
 */
function behaviorMatches(observed: string, expected: string): boolean {
  const stopWords = new Set(["a", "an", "the", "to", "at", "on", "in", "for", "and", "or", "of", "is", "are", "when", "them", "they", "their", "you", "your", "it", "not", "yet", "other", "than"]);
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => !stopWords.has(w));

  const obsWords = normalize(observed);
  const expWords = normalize(expected);

  // Count how many significant expected-words appear in the observation
  const matchCount = expWords.filter((ew) => obsWords.some((ow) => ow.includes(ew) || ew.includes(ow))).length;
  // If at least half the keywords match, consider it a match
  return expWords.length > 0 && matchCount / expWords.length >= 0.5;
}

class MilestoneMatcherTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "EvaluateMilestones",
      {
        description:
          "Evaluates a pediatric patient's developmental milestones by comparing parent/physician-observed behaviors against CDC guidelines. " +
          "Checks FHIR Condition resources for prematurity, Down Syndrome, Cerebral Palsy, and Autism that may affect expectations. " +
          "Also pulls any existing FHIR Observation records for prior developmental data.",
        inputSchema: {
          patientId: z.string().optional().describe("The ID of the patient. Optional if context exists."),
          observedBehaviors: z.array(z.string()).describe("List of behaviors observed by the parent or physician, e.g. ['smiling', 'holds head steady', 'reaches for toys']."),
        },
      },
      async ({ patientId, observedBehaviors }) => {
        // --- 1. Resolve patient ---
        if (!patientId) {
          try {
            patientId = NullUtilities.getOrThrow(FhirUtilities.getPatientIdIfContextExists(req));
          } catch (error) {
            return McpUtilities.createTextResponse("Patient ID must be provided or contextually available via SHARP headers.", { isError: true });
          }
        }

        const patient = await FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`);
        if (!patient || !patient.birthDate) {
          return McpUtilities.createTextResponse("Patient not found or birth date missing in FHIR record.", { isError: true });
        }

        // --- 2. Calculate age ---
        const birthDate = parseISO(patient.birthDate);
        let ageInMonths = differenceInMonths(new Date(), birthDate);
        let adjustedAgeMonths = ageInMonths;

        // --- 3. Check Conditions (prematurity + broader) ---
        const detectedConditions: string[] = [];
        const conditionBundle = await FhirClientInstance.search(req, "Condition", [`patient=${patientId}`]);
        if (conditionBundle && conditionBundle.entry) {
          for (const entry of conditionBundle.entry) {
            const condition = entry.resource as fhirR4.Condition;
            const display = (condition.code?.coding?.[0]?.display || condition.code?.text || "").toLowerCase();
            for (const [keyword, message] of Object.entries(DEVELOPMENTAL_CONDITIONS)) {
              if (display.includes(keyword)) {
                detectedConditions.push(message);
                if (keyword === "premature" || keyword === "preterm") {
                  adjustedAgeMonths -= 2;
                  if (adjustedAgeMonths < 0) adjustedAgeMonths = 0;
                }
              }
            }
          }
        }
        // Deduplicate
        const uniqueConditions = [...new Set(detectedConditions)];

        // --- 4. Pull existing FHIR Observations ---
        const existingObservations: string[] = [];
        try {
          const obsBundle = await FhirClientInstance.search(req, "Observation", [`patient=${patientId}`]);
          if (obsBundle && obsBundle.entry) {
            for (const entry of obsBundle.entry) {
              const obs = entry.resource as fhirR4.Observation;
              const code = obs.code?.coding?.[0]?.display || obs.code?.text || "Unknown";
              const value = obs.valueString || obs.valueQuantity?.value?.toString() || obs.valueCodeableConcept?.text || "recorded";
              existingObservations.push(`${code}: ${value}`);
            }
          }
        } catch {
          // Non-critical — just means no observations exist
        }

        // --- 5. Match against CDC milestones ---
        let expectedMilestones = cdcData.milestones[0];
        for (const ms of cdcData.milestones) {
          if (ms.month <= adjustedAgeMonths) {
            expectedMilestones = ms;
          }
        }

        // --- 6. Smart matching: categorize each expected milestone ---
        const allExpected: { category: string; milestone: string }[] = [];
        for (const [cat, items] of Object.entries(expectedMilestones) as [string, any][]) {
          if (cat === "month" || cat === "vaccines") continue;
          if (Array.isArray(items)) {
            for (const item of items) {
              allExpected.push({ category: cat, milestone: item });
            }
          }
        }

        const met: { category: string; milestone: string }[] = [];
        const notYet: { category: string; milestone: string }[] = [];
        const unmatchedObservations: string[] = [];

        for (const exp of allExpected) {
          const isObserved = observedBehaviors.some((ob) => behaviorMatches(ob, exp.milestone));
          if (isObserved) {
            met.push(exp);
          } else {
            notYet.push(exp);
          }
        }

        // Check if any observations are AHEAD of the current bracket
        const aheadOfSchedule: string[] = [];
        const nextBracketIndex = cdcData.milestones.findIndex((ms: any) => ms.month === expectedMilestones.month) + 1;
        if (nextBracketIndex < cdcData.milestones.length) {
          const nextMilestones = cdcData.milestones[nextBracketIndex];
          for (const [cat, items] of Object.entries(nextMilestones) as [string, any][]) {
            if (cat === "month" || cat === "vaccines") continue;
            if (Array.isArray(items)) {
              for (const item of items) {
                if (observedBehaviors.some((ob) => behaviorMatches(ob, item))) {
                  aheadOfSchedule.push(`${item} (${cat}, typically ${nextMilestones.month}mo)`);
                }
              }
            }
          }
        }

        // Find observations that didn't match anything
        for (const ob of observedBehaviors) {
          const matchedAnything = allExpected.some((exp) => behaviorMatches(ob, exp.milestone));
          if (!matchedAnything) {
            unmatchedObservations.push(ob);
          }
        }

        // --- 7. Build response ---
        const categoryLabel: Record<string, string> = {
          social: "Social/Emotional",
          communication: "Language/Communication",
          cognitive: "Cognitive",
          physical: "Physical/Motor",
        };

        let r = `### Developmental Milestone Evaluation\n\n`;
        r += `**Patient:** ${patient.name?.[0]?.given?.join(" ") || ""} ${patient.name?.[0]?.family || ""} (${patientId})\n`;

        if (uniqueConditions.length > 0) {
          r += `\n🚨 **Clinical Conditions Detected:**\n`;
          uniqueConditions.forEach((c) => (r += `- ${c}\n`));
          r += `\n**Chronological Age:** ${ageInMonths} months\n`;
          r += `**Adjusted/Corrected Age:** ${adjustedAgeMonths} months\n`;
        } else {
          r += `**Current Age:** ${ageInMonths} months\n`;
        }
        r += `**Milestone Target Bracket:** ${expectedMilestones.month} months\n\n`;

        // Existing FHIR observations
        if (existingObservations.length > 0) {
          r += `#### 📋 Prior FHIR Observations on Record:\n`;
          existingObservations.forEach((o) => (r += `- ${o}\n`));
          r += `\n`;
        }

        // Met milestones
        r += `#### ✅ Milestones Met (${met.length}/${allExpected.length}):\n`;
        if (met.length > 0) {
          met.forEach((m) => (r += `- **${categoryLabel[m.category] || m.category}:** ${m.milestone}\n`));
        } else {
          r += `- None of the reported observations matched expected milestones.\n`;
        }
        r += `\n`;

        // Not yet milestones
        r += `#### ⏳ Milestones Not Yet Observed (${notYet.length}/${allExpected.length}):\n`;
        if (notYet.length > 0) {
          notYet.forEach((m) => (r += `- **${categoryLabel[m.category] || m.category}:** ${m.milestone}\n`));
        } else {
          r += `- All expected milestones have been observed! 🎉\n`;
        }
        r += `\n`;

        // Ahead of schedule
        if (aheadOfSchedule.length > 0) {
          r += `#### 🌟 Ahead of Schedule:\n`;
          aheadOfSchedule.forEach((a) => (r += `- ${a}\n`));
          r += `\n`;
        }

        // Unmatched observations
        if (unmatchedObservations.length > 0) {
          r += `#### 📝 Other Reported Observations (not in current milestone bracket):\n`;
          unmatchedObservations.forEach((o) => (r += `- ${o}\n`));
          r += `\n`;
        }

        r += `---\n*Data sourced from CDC developmental milestones. Clinical conditions cross-referenced from FHIR Condition records. Prior observations pulled from FHIR Observation resources.*`;

        return McpUtilities.createTextResponse(r);
      }
    );
  }
}

export const MilestoneMatcherToolInstance = new MilestoneMatcherTool();
