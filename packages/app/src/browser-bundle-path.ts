import path from "node:path"

// Used only by the build guard, never by the browser runtime.
export function browserInputPath(file: string, directory = process.cwd(), paths = path) {
  // Bun 1.3.14 treats drive letters as path segments in metafile display paths. A C: input relative to a D:
  // checkout becomes ../../…/C:/…; Windows resolve would incorrectly turn that into D:\C:\….
  return paths.resolve(directory, paths.sep === "\\" ? file.replace(/^(?:\.\.[\\/])+([a-z]:[\\/])/i, "$1") : file)
}
