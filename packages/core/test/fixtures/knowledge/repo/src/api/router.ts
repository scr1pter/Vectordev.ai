type Response = { json(value: unknown): Response; status(code: number): Response; end(): Response }
type Request = { params: Record<string, string>; body: unknown }
type Handler = (request: Request, response: Response) => unknown

export const router = {
  get: (path: string, handler: Handler) => ({ path, handler }),
  post: (path: string, handler: Handler) => ({ path, handler }),
  delete: (path: string, handler: Handler) => ({ path, handler }),
}
