export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, 409, "CONFLICT");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export type ValidationProblem = { stepKey?: string; problem: string };

export class ValidationError extends AppError {
  constructor(
    message = "Validation failed",
    public readonly details: ValidationProblem[] = [],
  ) {
    super(message, 400, "VALIDATION_ERROR");
  }
}
