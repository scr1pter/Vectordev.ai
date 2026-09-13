import { Icon } from "@opencode-ai/ui/icon"

// The panel draws with Vector's shared icon set, the one the session header's
// Tasks, Changes and Terminal buttons use: square caps and a 1-unit stroke,
// about 0.8px at 16px. Each is a 16px [data-component="icon"] box that takes
// its colour from the control around it (see background-tasks.css).

export const PopOutIcon = () => <Icon size="small" name="square-arrow-top-right" />

/** A right-hand panel, where Dock puts the pane back; the side panel's own toggle draws it the same way. */
export const DockIcon = () => <Icon size="small" name="layout-right" />

export const ExpandIcon = () => <Icon size="small" name="expand" />

export const CollapseIcon = () => <Icon size="small" name="collapse" />

export const CloseIcon = () => <Icon size="small" name="close" />

export const ChevronIcon = () => <Icon size="small" name="chevron-right" />

export const TrashIcon = () => <Icon size="small" name="trash" />

export const StopIcon = () => <Icon size="small" name="stop" />

/** The done mark at the start of an agent row. */
export const CheckIcon = () => <Icon size="small" name="check-small" />
