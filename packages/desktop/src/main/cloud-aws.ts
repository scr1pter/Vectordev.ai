import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const DEFAULT_REGION = "us-east-1"

export type CloudAwsStatus = {
  installed: boolean
  configured: boolean
  version?: string
  accountId?: string
  arn?: string
  profile?: string
  profiles: string[]
  region: string
  detail: string
}

export type CloudAwsResource = {
  id: string
  name: string
  state?: string
  detail?: string
  createdAt?: string
}

export type CloudAwsService = {
  id: "s3" | "ec2" | "lambda" | "sagemaker" | "ecs"
  label: string
  available: boolean
  consoleUrl: string
  resources: CloudAwsResource[]
  detail?: string
}

export type CloudAwsSnapshot = {
  status: CloudAwsStatus
  services: CloudAwsService[]
  refreshedAt: string
}

function cleanVersion(value: string): string {
  return value.trim().split(/\s+/)[0] || "AWS CLI"
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return []
  const field = Reflect.get(value, key)
  return Array.isArray(field) ? field : []
}

function awsArgs(args: string[], input?: { profile?: string; region?: string }): string[] {
  const result = [...args]
  if (input?.profile) result.push("--profile", input.profile)
  if (input?.region) result.push("--region", input.region)
  if (!result.includes("--no-cli-pager")) result.push("--no-cli-pager")
  return result
}

async function runAws(args: string[], input?: { profile?: string; region?: string }): Promise<string> {
  const { stdout, stderr } = await execFileAsync("aws", awsArgs(args, input), {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      AWS_PAGER: "",
      AWS_EC2_METADATA_DISABLED: "true",
    },
  })
  return (stdout || stderr || "").trim()
}

async function runJson(args: string[], input?: { profile?: string; region?: string }): Promise<unknown> {
  const output = await runAws([...args, "--output", "json"], input)
  return output ? JSON.parse(output) : undefined
}

async function configuredRegion(profile?: string): Promise<string> {
  const args = ["configure", "get", "region"]
  if (profile) args.push("--profile", profile)
  return execFileAsync("aws", args, {
    timeout: 5_000,
    env: { ...process.env, AWS_PAGER: "", AWS_EC2_METADATA_DISABLED: "true" },
  })
    .then(({ stdout }) => stdout.trim() || DEFAULT_REGION)
    .catch(() => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION)
}

export async function getCloudAwsStatus(input?: { profile?: string; region?: string }): Promise<CloudAwsStatus> {
  let version = ""
  try {
    const result = await execFileAsync("aws", ["--version"], { timeout: 5_000 })
    version = cleanVersion(result.stdout || result.stderr || "")
  } catch {
    return {
      installed: false,
      configured: false,
      profiles: [],
      region: input?.region || DEFAULT_REGION,
      detail: "Install AWS CLI v2 to connect this computer to AWS.",
    }
  }

  const profiles = await execFileAsync("aws", ["configure", "list-profiles"], { timeout: 5_000 })
    .then(({ stdout }) =>
      stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .catch(() => [])
  const profile = input?.profile || process.env.AWS_PROFILE || profiles[0]
  const region = input?.region || (await configuredRegion(profile))
  try {
    const identity = await runJson(["sts", "get-caller-identity"], { profile, region })
    const accountId = stringField(identity, "Account")
    const arn = stringField(identity, "Arn")
    return {
      installed: true,
      configured: Boolean(accountId),
      version,
      accountId,
      arn,
      profile,
      profiles,
      region,
      detail: accountId ? `Connected to AWS account ${accountId}.` : "AWS credentials are not configured.",
    }
  } catch (error) {
    return {
      installed: true,
      configured: false,
      version,
      profile,
      profiles,
      region,
      detail: error instanceof Error ? error.message : "AWS credentials are not configured.",
    }
  }
}

function serviceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settledService(
  id: CloudAwsService["id"],
  label: string,
  consoleUrl: string,
  result: PromiseSettledResult<CloudAwsResource[]>,
): CloudAwsService {
  return result.status === "fulfilled"
    ? { id, label, available: true, consoleUrl, resources: result.value }
    : { id, label, available: false, consoleUrl, resources: [], detail: serviceError(result.reason) }
}

export async function listCloudAwsResources(input?: { profile?: string; region?: string }): Promise<CloudAwsSnapshot> {
  const status = await getCloudAwsStatus(input)
  const region = status.region
  const base = `https://${region}.console.aws.amazon.com`
  if (!status.configured) {
    return {
      status,
      refreshedAt: new Date().toISOString(),
      services: [
        {
          id: "s3",
          label: "S3 Storage",
          available: false,
          consoleUrl: "https://s3.console.aws.amazon.com/s3/home",
          resources: [],
          detail: status.detail,
        },
        {
          id: "ec2",
          label: "EC2 Compute",
          available: false,
          consoleUrl: `${base}/ec2/home?region=${region}#Instances:`,
          resources: [],
          detail: status.detail,
        },
        {
          id: "lambda",
          label: "Lambda Functions",
          available: false,
          consoleUrl: `${base}/lambda/home?region=${region}#/functions`,
          resources: [],
          detail: status.detail,
        },
        {
          id: "sagemaker",
          label: "SageMaker Training",
          available: false,
          consoleUrl: `${base}/sagemaker/home?region=${region}#/jobs`,
          resources: [],
          detail: status.detail,
        },
        {
          id: "ecs",
          label: "ECS Containers",
          available: false,
          consoleUrl: `${base}/ecs/v2/clusters?region=${region}`,
          resources: [],
          detail: status.detail,
        },
      ],
    }
  }

  const commandInput = { profile: status.profile, region }
  const [s3, ec2, lambda, sagemaker, ecs] = await Promise.allSettled([
    runJson(["s3api", "list-buckets"], commandInput).then((value) =>
      arrayField(value, "Buckets").map((item) => ({
        id: stringField(item, "Name") || "bucket",
        name: stringField(item, "Name") || "Unnamed bucket",
        createdAt: stringField(item, "CreationDate"),
      })),
    ),
    runJson(
      [
        "ec2",
        "describe-instances",
        "--max-results",
        "100",
        "--query",
        "Reservations[].Instances[].{id:InstanceId,name:Tags[?Key=='Name']|[0].Value,state:State.Name,type:InstanceType}",
      ],
      commandInput,
    ).then((value) =>
      (Array.isArray(value) ? value : []).map((item) => ({
        id: stringField(item, "id") || "instance",
        name: stringField(item, "name") || stringField(item, "id") || "EC2 instance",
        state: stringField(item, "state"),
        detail: stringField(item, "type"),
      })),
    ),
    runJson(
      [
        "lambda",
        "list-functions",
        "--max-items",
        "100",
        "--query",
        "Functions[].{id:FunctionArn,name:FunctionName,runtime:Runtime,updated:LastModified}",
      ],
      commandInput,
    ).then((value) =>
      (Array.isArray(value) ? value : []).map((item) => ({
        id: stringField(item, "id") || stringField(item, "name") || "function",
        name: stringField(item, "name") || "Lambda function",
        detail: stringField(item, "runtime"),
        createdAt: stringField(item, "updated"),
      })),
    ),
    runJson(
      [
        "sagemaker",
        "list-training-jobs",
        "--max-results",
        "50",
        "--sort-by",
        "CreationTime",
        "--sort-order",
        "Descending",
      ],
      commandInput,
    ).then((value) =>
      arrayField(value, "TrainingJobSummaries").map((item) => ({
        id: stringField(item, "TrainingJobArn") || stringField(item, "TrainingJobName") || "training-job",
        name: stringField(item, "TrainingJobName") || "SageMaker training job",
        state: stringField(item, "TrainingJobStatus"),
        createdAt: stringField(item, "CreationTime"),
      })),
    ),
    runJson(["ecs", "list-clusters"], commandInput).then((value) =>
      arrayField(value, "clusterArns").map((item) => {
        const arn = typeof item === "string" ? item : ""
        return { id: arn || "cluster", name: arn.split("/").at(-1) || "ECS cluster" }
      }),
    ),
  ])

  return {
    status,
    refreshedAt: new Date().toISOString(),
    services: [
      settledService("s3", "S3 Storage", "https://s3.console.aws.amazon.com/s3/home", s3),
      settledService("ec2", "EC2 Compute", `${base}/ec2/home?region=${region}#Instances:`, ec2),
      settledService("lambda", "Lambda Functions", `${base}/lambda/home?region=${region}#/functions`, lambda),
      settledService("sagemaker", "SageMaker Training", `${base}/sagemaker/home?region=${region}#/jobs`, sagemaker),
      settledService("ecs", "ECS Containers", `${base}/ecs/v2/clusters?region=${region}`, ecs),
    ],
  }
}
