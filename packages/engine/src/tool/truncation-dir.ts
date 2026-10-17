import path from "path"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"

// Global initialization has created the data directory; resolve its Windows 8.3 alias before tool-output exists.
export const TRUNCATION_DIR = path.join(FSUtil.normalizePath(Global.Path.data), "tool-output")
