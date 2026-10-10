import { booleanField, numberField, projectService, responseArray, stringField, type SupabaseContext } from "./cloud-supabase-api"

// Storage buckets of the linked project, through its own Storage API with the
// service-role key held in this process.
// https://supabase.com/docs/reference/javascript/storage-createbucket

export type StorageBucket = {
  id: string
  name: string
  public: boolean
  fileSizeLimit?: number
  allowedMimeTypes?: string[]
  createdAt?: string
  updatedAt?: string
}

export type BucketInput = {
  name: string
  public?: boolean
  fileSizeLimit?: number | null
  allowedMimeTypes?: string[] | null
}

// Bucket names become URL path segments and object keys' first segment.
// https://supabase.com/docs/guides/storage/buckets/fundamentals
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/

function summarize(bucket: unknown): StorageBucket | undefined {
  const id = stringField(bucket, "id") ?? stringField(bucket, "name")
  if (!id) return
  const mimes = bucket && typeof bucket === "object" ? Reflect.get(bucket, "allowed_mime_types") : undefined
  return {
    id,
    name: stringField(bucket, "name") ?? id,
    public: booleanField(bucket, "public") === true,
    fileSizeLimit: numberField(bucket, "file_size_limit"),
    allowedMimeTypes: Array.isArray(mimes) ? mimes.filter((item): item is string => typeof item === "string") : undefined,
    createdAt: stringField(bucket, "created_at"),
    updatedAt: stringField(bucket, "updated_at"),
  }
}

function bucketName(value: string) {
  const name = value.trim()
  if (!BUCKET_NAME.test(name)) {
    throw new Error(`"${value}" is not a bucket name. Use lowercase letters, numbers, dots, hyphens and underscores.`)
  }
  return name
}

function limits(input: BucketInput) {
  if (input.fileSizeLimit !== undefined && input.fileSizeLimit !== null) {
    if (!Number.isInteger(input.fileSizeLimit) || input.fileSizeLimit <= 0) {
      throw new Error("The file size limit is a whole number of bytes.")
    }
  }
  const mimes = input.allowedMimeTypes?.map((item) => item.trim()).filter(Boolean)
  if (mimes?.some((item) => !/^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/i.test(item))) {
    throw new Error("Allowed file types are MIME types such as image/png or image/*.")
  }
  return { fileSizeLimit: input.fileSizeLimit, allowedMimeTypes: input.allowedMimeTypes === null ? null : mimes }
}

export async function listBuckets(context: SupabaseContext) {
  const buckets = responseArray(await projectService(context, "/storage/v1/bucket"))
    .map(summarize)
    .filter((bucket): bucket is StorageBucket => Boolean(bucket))
  return { buckets }
}

export async function createBucket(context: SupabaseContext, input: BucketInput) {
  const name = bucketName(input.name)
  const limit = limits(input)
  await projectService(context, "/storage/v1/bucket", {
    method: "POST",
    json: {
      id: name,
      name,
      public: input.public === true,
      file_size_limit: limit.fileSizeLimit ?? null,
      allowed_mime_types: limit.allowedMimeTypes?.length ? limit.allowedMimeTypes : null,
    },
  })
  return {
    bucket: name,
    detail: `${input.public === true ? "Public" : "Private"} bucket ${name} created in ${context.projectName}.${
      input.public === true ? " Anyone with a file's URL can read it." : " Reads and writes follow its storage policies."
    }`,
  }
}

// Fields left out keep their current value; the Storage API replaces them all.
export async function updateBucket(context: SupabaseContext, input: BucketInput) {
  const name = bucketName(input.name)
  const current = summarize(await projectService(context, `/storage/v1/bucket/${encodeURIComponent(name)}`))
  if (!current) throw new Error(`Bucket ${name} was not found in ${context.projectName}.`)
  const limit = limits(input)
  const next = {
    id: name,
    name,
    public: input.public ?? current.public,
    file_size_limit: limit.fileSizeLimit === undefined ? (current.fileSizeLimit ?? null) : limit.fileSizeLimit,
    allowed_mime_types:
      limit.allowedMimeTypes === undefined
        ? (current.allowedMimeTypes ?? null)
        : limit.allowedMimeTypes?.length
          ? limit.allowedMimeTypes
          : null,
  }
  await projectService(context, `/storage/v1/bucket/${encodeURIComponent(name)}`, { method: "PUT", json: next })
  return { bucket: name, public: next.public, detail: `Bucket ${name} updated.` }
}

// Supabase refuses to delete a bucket that still holds files; emptying it
// first deletes every object in it, which is why it is a separate choice.
export async function deleteBucket(context: SupabaseContext, input: { name: string; empty?: boolean }) {
  const name = bucketName(input.name)
  if (input.empty === true) {
    await projectService(context, `/storage/v1/bucket/${encodeURIComponent(name)}/empty`, { method: "POST" })
  }
  await projectService(context, `/storage/v1/bucket/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(
    (error: Error) => {
      throw new Error(
        /not empty/i.test(error.message)
          ? `Bucket ${name} still has files. Empty it as well to delete it; that deletes every file in it.`
          : error.message,
      )
    },
  )
  return { deleted: name, emptied: input.empty === true, detail: `Bucket ${name} was deleted.` }
}
