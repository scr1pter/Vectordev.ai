import "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: {
        src?: string
        class?: string
        partition?: string
        allowpopups?: string | boolean
        title?: string
      }
    }
  }
}
