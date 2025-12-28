import { z } from "zod";

export const createChecklistSchema = z.object({
  title: z.string().min(3).max(120),
  imageId: z.string().optional()

});

export const addStepSchema = z.object({
  label: z.string().min(3).max(200),
  imageId: z.string().optional()

});

export const createIncidentSchema = z.object({
  title: z.string().min(3).max(160),
  severity: z.number().int().min(1).max(5),
  imageId: z.string().optional()

});

export const addIncidentUpdateSchema = z.object({
  note: z.string().min(2).max(500),
  imageId: z.string().optional()

});

export const patchIncidentStatusSchema = z.object({
  status: z.enum(["open", "investigating", "mitigated", "resolved"])
});


// -----------------------------------------------------------------------------
// Team / Presence
// -----------------------------------------------------------------------------

export const sendMessageSchema = z.object({
  body: z.string().min(1).max(2000),
  page: z.string().max(200).optional(),
  imageId: z.string().optional()
});

export const pingPresenceSchema = z.object({
  page: z.string().max(200).optional(),
});
