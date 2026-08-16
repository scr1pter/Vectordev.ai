const PROVIDER_READY = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const HEIF_MIMES = new Set(["image/heic", "image/heif"])

type HeicConverter = (bytes: Uint8Array) => Promise<{ data: Uint8Array; mime: string } | { error: string }>
const MAX_EDGE = 2_000

export type PreparedImage = {
  blob: Blob
  mime: string
}

function canvasBlob(canvas: HTMLCanvasElement, mime = "image/png", quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error("Vector could not encode this image."))
      },
      mime,
      quality,
    )
  })
}

function imageDataValue(value: number, max: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round((value / max) * 255)))
}

async function decodeTiff(file: File) {
  const { decode } = await import("tiff")
  const page = decode(await file.arrayBuffer(), { pages: [0] })[0]
  if (!page || !page.width || !page.height || !page.data.length) throw new Error("This TIFF has no readable image.")

  const components = page.components
  if (components < 1 || components > 4) throw new Error("This TIFF color layout is not supported.")
  const max = page.maxSampleValue || 2 ** Math.min(page.bitsPerSample || 8, 24) - 1
  const rgba = new Uint8ClampedArray(page.width * page.height * 4)
  for (let pixel = 0; pixel < page.width * page.height; pixel += 1) {
    const source = pixel * components
    const target = pixel * 4
    const grayscale = components <= 2
    rgba[target] = imageDataValue(page.data[source] ?? 0, max)
    rgba[target + 1] = imageDataValue(page.data[source + (grayscale ? 0 : 1)] ?? 0, max)
    rgba[target + 2] = imageDataValue(page.data[source + (grayscale ? 0 : 2)] ?? 0, max)
    rgba[target + 3] =
      components === 2 || components === 4 ? imageDataValue(page.data[source + components - 1] ?? max, max) : 255
  }

  const canvas = document.createElement("canvas")
  canvas.width = page.width
  canvas.height = page.height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Vector could not prepare the TIFF image.")
  context.putImageData(new ImageData(rgba, page.width, page.height), 0, 0)
  return canvasBlob(canvas)
}

async function drawToPng(blob: Blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" })
  try {
    const scale = Math.min(1, MAX_EDGE / bitmap.width, MAX_EDGE / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Vector could not prepare this image.")
    context.drawImage(bitmap, 0, 0, width, height)
    return canvasBlob(canvas)
  } finally {
    bitmap.close()
  }
}


// HEIC is decoded by the operating system rather than a bundled decoder. Every
// JavaScript HEIC library wraps libheif, which is LGPL, and statically bundling
// that into a closed-source product conflicts with the licence.
async function decodeHeif(file: File): Promise<Blob> {
  const convert = (globalThis.window as unknown as { api?: { convertHeic?: HeicConverter } } | undefined)?.api
    ?.convertHeic
  if (!convert) {
    // The web build has no desktop bridge; the browser may still decode it.
    return drawToPng(file).catch(() => {
      throw new Error("Vector cannot convert HEIC images here. Attach a JPEG or PNG instead.")
    })
  }
  const result = await convert(new Uint8Array(await file.arrayBuffer()))
  if ("error" in result) throw new Error(result.error)
  // Copy into a fresh ArrayBuffer: the IPC result can be backed by a shared
  // buffer, which BlobPart does not accept.
  return new Blob([new Uint8Array(result.data).slice().buffer], { type: result.mime })
}

export async function prepareImageForModel(file: File, mime: string): Promise<PreparedImage> {
  if (!mime.startsWith("image/") || PROVIDER_READY.has(mime)) return { blob: file, mime }

  if (HEIF_MIMES.has(mime)) return { blob: await decodeHeif(file), mime: "image/jpeg" }

  if (mime === "image/tiff") return { blob: await decodeTiff(file), mime: "image/png" }
  return { blob: await drawToPng(file), mime: "image/png" }
}
