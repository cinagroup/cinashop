/** A business refusal is certain only when the transport did not report a server failure. */
export function communityClosedResponse(value: { status?: number; httpStatus?: number }): boolean {
  return value.status === 410010 && !(value.httpStatus !== undefined && value.httpStatus >= 500);
}

export function communityCertainRejection(value: { status?: number; httpStatus?: number }): boolean {
  return !(value.httpStatus !== undefined && value.httpStatus >= 500) && value.status !== undefined
    && (value.status >= 400 && value.status < 500 || [410000, 410001, 410002, 410010].includes(value.status));
}
