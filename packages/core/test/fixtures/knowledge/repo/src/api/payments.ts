import { router } from "./router"

router.post("/v1/payments/events", (request, response) => response.status(200).end())
