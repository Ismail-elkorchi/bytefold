export type ExternalToolErrorCode =
  | 'EXTERNAL_TOOL_MISSING'
  | 'EXTERNAL_TOOL_FAILED'
  | 'EXTERNAL_TOOL_BAD_OUTPUT';

export class ExternalToolError extends Error {
  readonly code: ExternalToolErrorCode;
  readonly tool?: string;
  readonly cause?: unknown;

  constructor(
    code: ExternalToolErrorCode,
    message: string,
    options?: { tool?: string; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ExternalToolError';
    this.code = code;
    if (options?.tool !== undefined) this.tool = options.tool;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
