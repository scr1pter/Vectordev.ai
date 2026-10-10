import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js"
import type { StorageBucket } from "./supabase-api"
import { createConfirm, failed, formatWhen, NotLinked, PanelHead, type SupabasePanelProps } from "./supabase-ui"
import "./supabase.css"

// Storage buckets of the linked project: create, make public or private,
// limit size and file types, and delete (emptying first only when asked).

export function SupabaseStorage(props: SupabasePanelProps & { icon: JSX.Element }) {
  const confirm = createConfirm()
  const [buckets, setBuckets] = createSignal<StorageBucket[]>()
  const [busy, setBusy] = createSignal("")
  const [name, setName] = createSignal("")
  const [makePublic, setMakePublic] = createSignal(false)
  const [sizeMb, setSizeMb] = createSignal("")
  const [types, setTypes] = createSignal("")
  const [notEmpty, setNotEmpty] = createSignal("")

  const load = async () => {
    const report = await props.client.buckets()
    if (failed(props.notice, report)) return
    setBuckets(report.buckets ?? [])
  }

  createEffect(
    on(
      () => props.linked,
      (linked) => {
        setBuckets(undefined)
        if (linked) void load()
      },
    ),
  )

  const act = async (id: string, work: () => Promise<void>) => {
    if (busy()) return
    setBusy(id)
    try {
      await work()
    } finally {
      setBusy("")
    }
  }

  const create = () =>
    act("create", async () => {
      const megabytes = Number(sizeMb())
      const report = await props.client.createBucket({
        bucket: name().trim(),
        public: makePublic(),
        fileSizeLimit: sizeMb().trim() && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : undefined,
        allowedMimeTypes: types()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      })
      if (failed(props.notice, report)) return
      props.notice({ tone: "success", text: report.detail ?? "Bucket created." })
      setName("")
      setSizeMb("")
      setTypes("")
      setMakePublic(false)
      await load()
    })

  const toggle = (bucket: StorageBucket) =>
    act(`toggle-${bucket.id}`, async () => {
      const report = await props.client.updateBucket({ bucket: bucket.id, public: !bucket.public })
      if (failed(props.notice, report)) return
      props.notice({ tone: "success", text: `${bucket.name} is now ${bucket.public ? "private" : "public"}.` })
      await load()
    })

  const remove = (bucket: StorageBucket, empty: boolean) =>
    act(`delete-${bucket.id}`, async () => {
      const report = await props.client.deleteBucket(bucket.id, empty)
      if (!report.ok && /still has files/.test(report.error ?? "")) {
        setNotEmpty(bucket.id)
        props.notice({ tone: "info", text: report.error ?? "" })
        return
      }
      if (failed(props.notice, report)) return
      setNotEmpty("")
      props.notice({ tone: "info", text: report.detail ?? "Bucket deleted." })
      await load()
    })

  return (
    <Show
      when={props.linked}
      fallback={
        <NotLinked
          onOpenDatabase={props.onOpenDatabase}
          what="Storage buckets live in the Supabase project this repository uses."
          icon={props.icon}
        />
      }
    >
      <div class="sb-stack">
        <div class="cloud-panel">
          <PanelHead
            title="New bucket"
            detail="Private buckets follow your storage policies; anyone with a file's URL can read a public one."
          />
          <div class="sb-grid mt-3">
            <label class="sb-field">
              <span>Name</span>
              <input
                class="cloud-input"
                placeholder="avatars"
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label class="sb-field">
              <span>Largest file (MB, optional)</span>
              <input
                class="cloud-input"
                inputmode="decimal"
                placeholder="No limit"
                value={sizeMb()}
                onInput={(event) => setSizeMb(event.currentTarget.value)}
              />
            </label>
            <label class="sb-field">
              <span>Allowed file types (optional)</span>
              <input
                class="cloud-input"
                placeholder="image/*, application/pdf"
                value={types()}
                onInput={(event) => setTypes(event.currentTarget.value)}
              />
            </label>
            <label class="sb-check" style={{ "align-self": "end", "min-height": "38px" }}>
              <input
                type="checkbox"
                checked={makePublic()}
                onChange={(event) => setMakePublic(event.currentTarget.checked)}
              />
              Public bucket
            </label>
          </div>
          <div class="sb-actions mt-3">
            <button
              class="cloud-button"
              data-variant="primary"
              type="button"
              disabled={!name().trim() || Boolean(busy())}
              onClick={() => void create()}
            >
              {busy() === "create" ? "Creating…" : "Create bucket"}
            </button>
          </div>
        </div>

        <div class="cloud-panel">
          <PanelHead title="Buckets">
            <button class="cloud-button" type="button" disabled={Boolean(busy())} onClick={() => void load()}>
              Refresh
            </button>
          </PanelHead>
          <div class="cloud-list mt-3">
            <For
              each={buckets() ?? []}
              fallback={<p class="cloud-muted text-[12px]">{buckets() ? "No buckets yet." : "Loading…"}</p>}
            >
              {(bucket) => (
                <div class="cloud-row">
                  <span class="min-w-0 flex-1">
                    <strong class="block truncate text-[13px]">{bucket.name}</strong>
                    <small class="cloud-muted">
                      {bucket.fileSizeLimit ? `up to ${(bucket.fileSizeLimit / 1024 / 1024).toFixed(1)} MB · ` : ""}
                      {bucket.allowedMimeTypes?.length ? `${bucket.allowedMimeTypes.join(", ")} · ` : ""}
                      updated {formatWhen(bucket.updatedAt)}
                    </small>
                  </span>
                  <span class="cloud-status" data-tone={bucket.public ? "warning" : "success"}>
                    {bucket.public ? "public" : "private"}
                  </span>
                  <button
                    class="cloud-button"
                    type="button"
                    disabled={Boolean(busy())}
                    onClick={() =>
                      bucket.public
                        ? void toggle(bucket)
                        : confirm.ask(`public-${bucket.id}`, () => void toggle(bucket))
                    }
                  >
                    {bucket.public
                      ? "Make private"
                      : confirm.armed() === `public-${bucket.id}`
                        ? "Anyone can read it. Sure?"
                        : "Make public"}
                  </button>
                  <button
                    class="cloud-button"
                    data-variant="danger"
                    type="button"
                    disabled={Boolean(busy())}
                    onClick={() => {
                      const empty = notEmpty() === bucket.id
                      confirm.ask(`delete-${bucket.id}`, () => void remove(bucket, empty))
                    }}
                  >
                    {confirm.armed() === `delete-${bucket.id}`
                      ? notEmpty() === bucket.id
                        ? "Delete every file too?"
                        : "Confirm delete?"
                      : notEmpty() === bucket.id
                        ? "Empty and delete"
                        : "Delete"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
