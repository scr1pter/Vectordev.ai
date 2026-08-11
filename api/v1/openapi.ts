import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

const bearer = [{ ApiKeyAuth: [] }]

export default function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const origin = (process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai").replace(/\/$/, "")
    json(response, 200, {
      openapi: "3.1.0",
      info: {
        title: "Vector API Platform",
        version: "1.1.0",
        description:
          "Execute and verify HTTP requests, launch isolated Vector Cloud Agents, and coordinate teams that automatically integrate their completed patches. Paid endpoints accept a scoped x-vector-api-key header.",
      },
      servers: [{ url: origin }],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: "apiKey", in: "header", name: "x-vector-api-key" },
        },
        schemas: {
          ApiExecution: {
            type: "object",
            required: ["url"],
            properties: {
              method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
                default: "GET",
              },
              url: { type: "string", format: "uri" },
              headers: { type: "object", additionalProperties: { type: "string" } },
              body: { type: "string", maxLength: 1000000 },
              timeoutMs: { type: "integer", minimum: 1000, maximum: 30000, default: 15000 },
            },
          },
          AgentRunCreate: {
            type: "object",
            required: ["name", "prompt"],
            properties: {
              name: { type: "string", maxLength: 100 },
              prompt: { type: "string", maxLength: 50000 },
              repositoryUrl: {
                type: "string",
                format: "uri",
                description: "A public HTTPS Git repository. Private repository connectors are planned.",
              },
              repositoryBranch: { type: "string" },
              model: { type: "string" },
              teamId: { type: "string", format: "uuid" },
              teamName: { type: "string", maxLength: 100 },
              teamObjective: { type: "string", maxLength: 12000 },
              selectedTools: { type: "array", maxItems: 24, items: { type: "string", format: "uuid" } },
            },
          },
          AgentAction: {
            type: "object",
            required: ["id", "action"],
            properties: {
              id: { type: "string", format: "uuid" },
              action: { type: "string", enum: ["continue", "stop"] },
              prompt: { type: "string", maxLength: 50000 },
            },
          },
          AgentTeamCreate: {
            type: "object",
            required: ["name", "objective", "missions"],
            properties: {
              name: { type: "string", maxLength: 100 },
              objective: { type: "string", maxLength: 12000 },
              mode: { type: "string", enum: ["coordinated", "isolated"], default: "coordinated" },
              repositoryUrl: { type: "string", format: "uri" },
              repositoryBranch: { type: "string" },
              model: { type: "string" },
              selectedTools: { type: "array", maxItems: 24, items: { type: "string", format: "uuid" } },
              missions: {
                type: "array",
                minItems: 2,
                maxItems: 16,
                items: {
                  type: "object",
                  required: ["name", "prompt"],
                  properties: {
                    name: { type: "string", maxLength: 100 },
                    prompt: { type: "string", maxLength: 50000 },
                  },
                },
              },
            },
          },
        },
      },
      paths: {
        "/api/v1/execute": {
          post: {
            summary: "Execute and inspect an HTTP request",
            description:
              "Runs a public HTTP request from Vector's cloud boundary and returns status, headers, body, timing, and response size. Private network targets are blocked.",
            security: bearer,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/ApiExecution" } } },
            },
            responses: {
              "200": { description: "Captured API response" },
              "400": { description: "Invalid or private target" },
              "402": { description: "Subscription required" },
            },
          },
        },
        "/api/v1/agents": {
          get: {
            summary: "List cloud agent workspaces",
            security: bearer,
            responses: { "200": { description: "Agent runs and available models" } },
          },
          post: {
            summary: "Launch an isolated cloud agent",
            security: bearer,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/AgentRunCreate" } } },
            },
            responses: {
              "201": { description: "Agent workspace launched" },
              "409": { description: "Active agent limit reached" },
            },
          },
        },
        "/api/v1/team": {
          post: {
            summary: "Launch a parallel cloud-agent team",
            description:
              "Creates 2-16 isolated worker missions. Coordinated teams automatically launch an integration workspace after every worker finishes; isolated teams stop at parallel review.",
            security: bearer,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/AgentTeamCreate" } } },
            },
            responses: {
              "201": { description: "Team and isolated workspaces created" },
              "409": { description: "Agent limit or setup conflict" },
            },
          },
        },
        "/api/v1/agent": {
          get: {
            summary: "Inspect and refresh an agent run",
            security: bearer,
            parameters: [{ name: "id", in: "query", required: true, schema: { type: "string", format: "uuid" } }],
            responses: { "200": { description: "Current run and conversation" } },
          },
          post: {
            summary: "Continue or stop an agent run",
            security: bearer,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/AgentAction" } } },
            },
            responses: {
              "200": { description: "Action accepted" },
              "202": { description: "Agent continuation started" },
            },
          },
          delete: {
            summary: "Delete an isolated agent workspace",
            security: bearer,
            parameters: [{ name: "id", in: "query", required: true, schema: { type: "string", format: "uuid" } }],
            responses: { "200": { description: "Workspace deleted" } },
          },
        },
      },
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
