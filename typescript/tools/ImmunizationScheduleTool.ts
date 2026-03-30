import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { differenceInMonths, differenceInWeeks, parseISO } from "date-fns";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";
import * as fs from "fs";
import * as path from "path";

// Load CDC Data for vaccines
const cdcDataPath = path.join(__dirname, "../milestones/cdc_data.json");
const cdcData = JSON.parse(fs.readFileSync(cdcDataPath, "utf-8"));

/**
 * Known vaccine-ingredient contraindications.
 * Maps common allergen keywords → vaccine names that should be flagged.
 */
const VACCINE_CONTRAINDICATIONS: Record<string, string[]> = {
  egg: ["Flu (Annual)"],
  neomycin: ["Polio (IPV)", "Rotavirus (RV)"],
  streptomycin: ["Polio (IPV)"],
  gelatin: ["Rotavirus (RV)"],
  yeast: ["HepB (2nd dose)", "HepB (3rd dose)"],
  latex: ["HepB (2nd dose)", "HepB (3rd dose)", "Hib"],
};

class ImmunizationScheduleTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetImmunizationSchedule",
      {
        description:
          "Evaluates a pediatric patient's immunization status by cross-referencing the CDC vaccine schedule with " +
          "already-administered FHIR Immunization records and the patient's FHIR AllergyIntolerance records to flag contraindications. " +
          "Returns a breakdown of completed, remaining, overdue, and contraindicated vaccines.",
        inputSchema: {
          patientId: z.string().optional().describe("The ID of the patient. Optional if context exists."),
        },
      },
      async ({ patientId }) => {
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
        const ageInMonths = differenceInMonths(new Date(), birthDate);
        const ageInWeeks = differenceInWeeks(new Date(), birthDate);

        // --- 3. Find target schedule bracket ---
        let expectedMilestones = cdcData.milestones[0];
        for (const ms of cdcData.milestones) {
          if (ms.month <= ageInMonths) {
            expectedMilestones = ms;
          }
        }

        // Collect ALL recommended vaccines up to current age (cumulative)
        const allRecommended: { vaccine: string; dueMonth: number }[] = [];
        for (const ms of cdcData.milestones) {
          if (ms.month <= ageInMonths && ms.vaccines) {
            for (const v of ms.vaccines) {
              if (v !== "None standard (Catch-up if missed)") {
                allRecommended.push({ vaccine: v, dueMonth: ms.month });
              }
            }
          }
        }

        // --- 4. Pull administered Immunizations from FHIR ---
        const administeredVaccines: { name: string; date: string }[] = [];
        try {
          const immunizationBundle = await FhirClientInstance.search(req, "Immunization", [`patient=${patientId}`]);
          if (immunizationBundle && immunizationBundle.entry) {
            for (const entry of immunizationBundle.entry) {
              const imm = entry.resource as fhirR4.Immunization;
              const name = imm.vaccineCode?.coding?.[0]?.display || imm.vaccineCode?.text || "Unknown vaccine";
              const date = imm.occurrenceDateTime || imm.occurrenceString || "date unknown";
              administeredVaccines.push({ name, date });
            }
          }
        } catch {
          // Non-critical — may not have any immunization records
        }

        // Normalize names for matching
        const normalizeVaccine = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const administeredNormalized = administeredVaccines.map((v) => normalizeVaccine(v.name));

        // Categorize
        const completed: { vaccine: string; dueMonth: number }[] = [];
        const remaining: { vaccine: string; dueMonth: number }[] = [];
        const overdue: { vaccine: string; dueMonth: number }[] = [];

        for (const rec of allRecommended) {
          const isAdministered = administeredNormalized.some(
            (av) => av.includes(normalizeVaccine(rec.vaccine)) || normalizeVaccine(rec.vaccine).includes(av)
          );
          if (isAdministered) {
            completed.push(rec);
          } else if (rec.dueMonth < expectedMilestones.month) {
            overdue.push(rec);
          } else {
            remaining.push(rec);
          }
        }

        // --- 5. Check AllergyIntolerance for contraindications ---
        const contraindications: { allergen: string; vaccines: string[] }[] = [];
        try {
          const allergyBundle = await FhirClientInstance.search(req, "AllergyIntolerance", [`patient=${patientId}`]);
          if (allergyBundle && allergyBundle.entry) {
            for (const entry of allergyBundle.entry) {
              const allergy = entry.resource as fhirR4.AllergyIntolerance;
              const allergenName = (allergy.code?.coding?.[0]?.display || allergy.code?.text || "").toLowerCase();
              for (const [keyword, vaccines] of Object.entries(VACCINE_CONTRAINDICATIONS)) {
                if (allergenName.includes(keyword)) {
                  contraindications.push({ allergen: allergenName, vaccines });
                }
              }
            }
          }
        } catch {
          // Non-critical
        }

        // Build set of contraindicated vaccine names
        const contraindicatedVaccines = new Set<string>();
        for (const ci of contraindications) {
          ci.vaccines.forEach((v) => contraindicatedVaccines.add(v));
        }

        // --- 6. Build response ---
        let r = `### Immunization Status Report\n\n`;
        r += `**Patient:** ${patient.name?.[0]?.given?.join(" ") || ""} ${patient.name?.[0]?.family || ""} (${patientId})\n`;
        r += `**Current Age:** ${ageInMonths} months (${ageInWeeks} weeks)\n`;
        r += `**Current Schedule Bracket:** ${expectedMilestones.month} months\n\n`;

        // Completed
        r += `#### ✅ Vaccines Administered (${completed.length}):\n`;
        if (completed.length > 0) {
          completed.forEach((v) => {
            const matchedRecord = administeredVaccines.find(
              (av) => normalizeVaccine(av.name).includes(normalizeVaccine(v.vaccine))
            );
            r += `- ${v.vaccine} (due at ${v.dueMonth}mo)${matchedRecord ? ` — given on ${matchedRecord.date}` : ""}\n`;
          });
        } else {
          r += `- No immunization records found in FHIR.\n`;
        }
        r += `\n`;

        // Remaining
        r += `#### 💉 Vaccines Still Needed (${remaining.length}):\n`;
        if (remaining.length > 0) {
          remaining.forEach((v) => {
            const isContraindicated = contraindicatedVaccines.has(v.vaccine);
            r += `- ${v.vaccine} (due at ${v.dueMonth}mo)${isContraindicated ? " ⚠️ **CONTRAINDICATION — see below**" : ""}\n`;
          });
        } else {
          r += `- All vaccines for this bracket have been administered! 🎉\n`;
        }
        r += `\n`;

        // Overdue
        if (overdue.length > 0) {
          r += `#### ⚠️ Overdue Vaccines (${overdue.length}):\n`;
          overdue.forEach((v) => {
            const isContraindicated = contraindicatedVaccines.has(v.vaccine);
            r += `- ${v.vaccine} (was due at ${v.dueMonth}mo — now ${ageInMonths - v.dueMonth} months overdue)${isContraindicated ? " ⚠️ **CONTRAINDICATION**" : ""}\n`;
          });
          r += `\n`;
        }

        // Contraindications
        if (contraindications.length > 0) {
          r += `#### 🚨 Allergy Contraindications Detected:\n`;
          for (const ci of contraindications) {
            r += `- **Allergen:** ${ci.allergen} → **Affected vaccines:** ${ci.vaccines.join(", ")}\n`;
          }
          r += `\n*Please consult with the physician before administering flagged vaccines.*\n\n`;
        }

        // Upcoming (next bracket)
        const nextBracketIndex = cdcData.milestones.findIndex((ms: any) => ms.month === expectedMilestones.month) + 1;
        if (nextBracketIndex < cdcData.milestones.length) {
          const next = cdcData.milestones[nextBracketIndex];
          if (next.vaccines && next.vaccines[0] !== "None standard (Catch-up if missed)") {
            r += `#### 📅 Upcoming at ${next.month} Months:\n`;
            next.vaccines.forEach((v: string) => (r += `- ${v}\n`));
            r += `\n`;
          }
        }

        r += `---\n*Administered vaccines sourced from FHIR Immunization records. Allergy contraindications cross-referenced from FHIR AllergyIntolerance resources. Schedule based on CDC recommended immunization schedule.*`;

        return McpUtilities.createTextResponse(r);
      }
    );
  }
}

export const ImmunizationScheduleToolInstance = new ImmunizationScheduleTool();
