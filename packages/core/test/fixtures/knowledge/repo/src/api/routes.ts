import { router } from "./router"

router.get("/v1/users/:id", (request, response) => response.json({ id: request.params.id }))
router.post("/v1/invoices", (request, response) => response.status(201).json(request.body))
router.delete("/v1/uploads/:id", (request, response) => response.status(204).end())
