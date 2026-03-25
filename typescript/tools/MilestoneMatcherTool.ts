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

class MilestoneMatcherTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "EvaluateMilestones",
      {
        description: "Evaluates a pediatric patient's developmental milestones based on observed behaviors.",
        inputSchema: {
          patientId: z.string().optional().describe("The ID of the patient. Optional if context exists."),
          observedBehaviors: z.array(z.string()).describe("List of behaviors observed by the parent or physician.")
        },
      },
      async ({ patientId, observedBehaviors }) => {
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

        const birthDate = parseISO(patient.birthDate);
        let ageInMonths = differenceInMonths(new Date(), birthDate);
        let adjustedAgeMonths = ageInMonths;
        let isPremature = false;

        // Fetch Conditions to check for prematurity
        const conditionBundle = await FhirClientInstance.search(req, "Condition", [`patient=${patientId}`]);
        if (conditionBundle && conditionBundle.entry) {
          for (const entry of conditionBundle.entry) {
            const condition = entry.resource as fhirR4.Condition;
            const display = condition.code?.coding?.[0]?.display?.toLowerCase() || condition.code?.text?.toLowerCase() || "";
            if (display.includes("premature") || display.includes("preterm")) {
              isPremature = true;
              // For hackathon MVP: we assume 8 weeks (2 months) premature as a standard mock.
              adjustedAgeMonths -= 2;
              if (adjustedAgeMonths < 0) adjustedAgeMonths = 0;
              break;
            }
          }
        }
        
        // Find closest milestone month <= adjustedAgeMonths
        let expectedMilestones = cdcData.milestones[0];
        for (const ms of cdcData.milestones) {
          if (ms.month <= adjustedAgeMonths) {
            expectedMilestones = ms;
          }
        }

        let responseText = `### Developmental Milestone Evaluation for Patient ${patientId}\n\n`;
        if (isPremature) {
          responseText += `🚨 **Prematurity Detected in FHIR Record.** Applying corrected age for developmental targets.\n\n`;
          responseText += `**Chronological Age:** ${ageInMonths} months\n`;
          responseText += `**Adjusted/Corrected Age:** ${adjustedAgeMonths} months\n`;
        } else {
          responseText += `**Current Age:** ${ageInMonths} months\n`;
        }
        responseText += `**Milestone Target:** ${expectedMilestones.month} months\n\n`;
        
        responseText += `#### Expected Target Milestones:\n`;
        responseText += `- **Social:** ${expectedMilestones.social.join(", ")}\n`;
        responseText += `- **Language:** ${expectedMilestones.communication.join(", ")}\n`;
        responseText += `- **Cognitive:** ${expectedMilestones.cognitive.join(", ")}\n`;
        responseText += `- **Physical:** ${expectedMilestones.physical.join(", ")}\n\n`;

        responseText += `#### Reported Observations:\n`;
        if (observedBehaviors && observedBehaviors.length > 0) {
          observedBehaviors.forEach((b: string) => responseText += `- ${b}\n`);
        } else {
          responseText += `- None recorded.\n`;
        }

        responseText += `\n*Note: Hackathon MVP. Adjusted age logic has been activated. NLP behavioral mapping will be integrated in v3.*`;

        return McpUtilities.createTextResponse(responseText);
      }
    );
  }
}

export const MilestoneMatcherToolInstance = new MilestoneMatcherTool();
