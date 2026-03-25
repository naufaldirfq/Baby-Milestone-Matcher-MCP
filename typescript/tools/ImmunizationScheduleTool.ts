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

// Load CDC Data for vaccines
const cdcDataPath = path.join(__dirname, "../milestones/cdc_data.json");
const cdcData = JSON.parse(fs.readFileSync(cdcDataPath, "utf-8"));

class ImmunizationScheduleTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetImmunizationSchedule",
      {
        description: "Evaluates a pediatric patient's required immunization and vaccination schedule based on their current clinical age.",
        inputSchema: {
          patientId: z.string().optional().describe("The ID of the patient. Optional if context exists."),
        },
      },
      async ({ patientId }) => {
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
        const ageInMonths = differenceInMonths(new Date(), birthDate);
        
        // Find closest milestone month <= ageInMonths
        let expectedMilestones = cdcData.milestones[0];
        for (const ms of cdcData.milestones) {
          if (ms.month <= ageInMonths) {
            expectedMilestones = ms;
          }
        }

        let responseText = `### Immunization Schedule for Patient ${patientId}\n\n`;
        responseText += `**Current Age:** ${ageInMonths} months\n`;
        responseText += `**Target Schedule:** ${expectedMilestones.month} months\n\n`;
        
        responseText += `#### Required Vaccines:\n`;
        if (expectedMilestones.vaccines && expectedMilestones.vaccines.length > 0) {
          expectedMilestones.vaccines.forEach((v: string) => responseText += `- ${v}\n`);
        } else {
          responseText += `- No standard vaccines expected for this exact bracket.\n`;
        }

        return McpUtilities.createTextResponse(responseText);
      }
    );
  }
}

export const ImmunizationScheduleToolInstance = new ImmunizationScheduleTool();
