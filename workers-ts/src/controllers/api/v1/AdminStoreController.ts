import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
type C = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function storeList(c: C) { return (await import("./AdminStoreAuthorController")).legacyList(c); }

export async function storeHeader(c: C) { return (await import("./AdminStoreAuthorController")).legacyHeader(c); }

export async function storeDetail(c: C) { return (await import("./AdminStoreAuthorController")).legacyDetail(c); }

export async function storeOptions(c: C) { return (await import("./AdminStoreAuthorController")).legacyOptions(c); }

export async function storeSave(c: C) { return (await import("./AdminStoreAuthorController")).legacySave(c); }

export async function storeVisibility(c: C) { return (await import("./AdminStoreAuthorController")).legacyShow(c); }

export async function storeDelete(c: C) { return (await import("./AdminStoreAuthorController")).legacyDelete(c); }

export async function staffList(c: C) { return (await import("./AdminStaffAuthorController")).legacyList(c); }

export async function staffForm(c: C) { return (await import("./AdminStaffAuthorController")).legacyForm(c); }

export async function staffSave(c: C) { return (await import("./AdminStaffAuthorController")).legacySave(c); }

export async function staffStatus(c: C) { return (await import("./AdminStaffAuthorController")).legacyStatus(c); }

export async function staffDelete(c: C) { return (await import("./AdminStaffAuthorController")).legacyDelete(c); }

export async function deliveryList(c: C) { return (await import("./AdminDeliveryAuthorController")).legacyList(c); }

export async function deliverySelectList(c: C) { return (await import("./AdminDeliveryAuthorController")).legacySelectList(c); }

export async function deliveryCandidates(c: C) { return (await import("./AdminDeliveryAuthorController")).legacyCandidates(c); }

export async function deliveryDetail(c: C) { return (await import("./AdminDeliveryAuthorController")).legacyForm(c); }

export async function deliverySave(c: C) { return (await import("./AdminDeliveryAuthorController")).legacySave(c); }

export async function deliveryUpdate(c: C) { return (await import("./AdminDeliveryAuthorController")).legacySave(c); }

export async function deliveryStatus(c: C) { return (await import("./AdminDeliveryAuthorController")).legacyStatus(c); }

export async function deliveryDelete(c: C) { return (await import("./AdminDeliveryAuthorController")).legacyDelete(c); }
