import { Router } from "express";

const router = Router();

type MeMode = "individual" | "family" | "workplace";

type FamilyMember = {
  id: string;
  displayName: string;
  relationship?: string;
  avatarUrl?: string | null;
};

type MeResponse = {
  userId: string;
  mode: MeMode;
  family: {
    activeMemberId: string | null;
    members: FamilyMember[];
  };
};

// In-memory store for MVP. Replace with DB later.
const ME_STORE = new Map<string, MeResponse>();

function getUserId(req: any): string {
  // If you later add real auth, swap this.
  return (req.header("x-user-id") || "dev-user").toString();
}

function seedIfMissing(userId: string): MeResponse {
  const existing = ME_STORE.get(userId);
  if (existing) return existing;

  // Seed that matches your current “Head/Spouse” UI
  const seeded: MeResponse = {
    userId,
    mode: "family",
    family: {
      activeMemberId: "u_head",
      members: [
        { id: "u_head", displayName: "Head", relationship: "self" },
        { id: "u_spouse", displayName: "Spouse", relationship: "spouse" },
      ],
    },
  };

  ME_STORE.set(userId, seeded);
  return seeded;
}

// GET /v1/me
router.get("/v1/me", (req, res) => {
  const userId = getUserId(req);
  const me = seedIfMissing(userId);
  res.json(me);
});

// PATCH /v1/me (optional but useful)
router.patch("/v1/me", (req, res) => {
  const userId = getUserId(req);
  const current = seedIfMissing(userId);

  const body = req.body || {};

  const next: MeResponse = {
    ...current,
    ...(body.mode ? { mode: body.mode } : null),
    family: {
      ...current.family,
      ...(body.family?.activeMemberId !== undefined
        ? { activeMemberId: body.family.activeMemberId }
        : null),
      ...(Array.isArray(body.family?.members) ? { members: body.family.members } : null),
    },
  };

  // Ensure activeMemberId exists in members
  if (next.family.activeMemberId) {
    const ok = next.family.members.some((m) => m.id === next.family.activeMemberId);
    if (!ok) next.family.activeMemberId = null;
  }

  ME_STORE.set(userId, next);
  res.json(next);
});

export default router;
