export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new ApiError(404, message)
  return value
}
