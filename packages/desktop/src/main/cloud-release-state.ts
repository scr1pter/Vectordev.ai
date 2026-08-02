import type { CloudDeployment } from "./cloud-console"

export function transitionReleaseRecords(
  records: CloudDeployment[],
  selectedId: string,
  input: { productionUrl?: string; rollback: boolean; at: string },
): CloudDeployment[] {
  const selected = records.find((item) => item.id === selectedId)
  if (!selected) return records
  return records.map((item) => {
    if (
      item.projectPath !== selected.projectPath ||
      item.taskId !== selected.taskId ||
      item.target !== selected.target
    ) return item
    if (item.id === selected.id) {
      return {
        ...item,
        environment: "production",
        releaseStatus: "current",
        productionUrl: input.productionUrl ?? item.productionUrl,
        promotedAt: input.at,
        rolledBackAt: undefined,
      }
    }
    if (item.releaseStatus !== "current") return item
    return {
      ...item,
      releaseStatus: input.rollback ? "rolled-back" : "superseded",
      rolledBackAt: input.rollback ? input.at : item.rolledBackAt,
    }
  })
}
