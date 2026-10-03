import { Elysia } from "elysia";
import { AppError, ValidationError } from "./errors";
import { logger } from "./logger";

export const errorHandling = new Elysia({ name: "error-handling" }).onError(
  { as: "global" },
  ({ code, error, set, request }) => {
    if (error instanceof ValidationError) {
      set.status = error.status;
      return {
        error: error.code,
        message: error.message,
        details: error.details,
      };
    }
    if (error instanceof AppError) {
      set.status = error.status;
      return { error: error.code, message: error.message };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      const first = error.valueError;
      const field = first?.path.replace(/^\//, "");
      const message = first
        ? `${field ? `${field}: ` : ""}${first.message}`
        : "Invalid request";
      return { error: "VALIDATION", message, details: error.all };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "NOT_FOUND", message: "Route not found" };
    }
    logger.error({
      event: "unhandled_error",
      method: request.method,
      url: request.url,
      error: error instanceof Error ? error.stack : String(error),
    });
    set.status = 500;
    return { error: "INTERNAL", message: "Internal server error" };
  },
);
