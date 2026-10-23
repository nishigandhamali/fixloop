export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new AppError(`${what.toUpperCase()}_NOT_FOUND`, `${what} not found`, 404);
export const forbidden = () => new AppError("FORBIDDEN", "Not authorized for this resource", 403);
