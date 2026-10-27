import { parseAllDocuments, stringify } from "yaml";
import { z } from "zod";
import { AppError, type Repair, type Scenario } from "./domain.js";

const deploymentSchema = z.object({
  apiVersion: z.literal("apps/v1"),
  kind: z.literal("Deployment"),
  metadata: z.object({ name: z.literal("checkout") }).passthrough(),
  spec: z.object({
    template: z.object({
      spec: z.object({
        nodeSelector: z.record(z.string(), z.string()),
        containers: z.tuple([z.object({
          name: z.literal("checkout"),
          env: z.tuple([z.object({
            name: z.literal("CHECKOUT_MODE"), value: z.string()
          })])
        }).passthrough()])
      }).passthrough()
    }).passthrough()
  }).passthrough()
}).passthrough();
const serviceSchema = z.object({
  apiVersion: z.literal("v1"),
  kind: z.literal("Service"),
  metadata: z.object({ name: z.literal("checkout") }).passthrough(),
  spec: z.object({
    ports: z.tuple([z.object({
      name: z.literal("http"), port: z.literal(80), targetPort: z.number()
    }).passthrough()])
  }).passthrough()
}).passthrough();

export function manifests(content: string) {
  const docs = parseAllDocuments(content);
  if (docs.length !== 2 || docs.some(doc => doc.errors.length)) {
    throw new AppError(422, "Expected exactly the checkout Deployment and Service patch documents");
  }
  return {
    deployment: deploymentSchema.parse(docs[0]!.toJSON()),
    service: serviceSchema.parse(docs[1]!.toJSON())
  };
}
function encode(value: ReturnType<typeof manifests>): string {
  return stringify(value.deployment) + "---\n" + stringify(value.service);
}
export function baseline(content: string): string {
  const value = manifests(content);
  value.service.spec.ports[0].targetPort = 8080;
  value.deployment.spec.template.spec.containers[0].env[0].value = "conference";
  value.deployment.spec.template.spec.nodeSelector = { "kubernetes.io/os": "linux" };
  return encode(value);
}
export function fault(content: string, scenario: Scenario): string {
  const value = manifests(baseline(content));
  if (scenario === "port") value.service.spec.ports[0].targetPort = 9999;
  if (scenario === "configuration") {
    value.deployment.spec.template.spec.containers[0].env[0].value = "invalid-demo-mode";
  }
  if (scenario === "scheduling") {
    value.deployment.spec.template.spec.nodeSelector["booth.example/scenario"] = "no-such-node";
  }
  return encode(value);
}
export function repair(content: string, change: Repair): string {
  const value = manifests(content);
  if (change.field === "targetPort" && change.value === 8080) {
    value.service.spec.ports[0].targetPort = change.value;
  } else if (change.field === "checkoutMode" && change.value === "conference") {
    value.deployment.spec.template.spec.containers[0].env[0].value = change.value;
  } else if (change.field === "nodeSelector" && typeof change.value === "object" &&
    Object.keys(change.value).length === 1 && change.value["kubernetes.io/os"] === "linux") {
    value.deployment.spec.template.spec.nodeSelector = change.value;
  } else {
    throw new AppError(422, "Repair value is outside the booth field/value allowlist");
  }
  const updated = encode(value);
  if (updated === encode(manifests(content))) throw new AppError(422, "Repair does not change the selected field");
  return updated;
}
export function isBaseline(content: string): boolean {
  return encode(manifests(content)) === baseline(content);
}
