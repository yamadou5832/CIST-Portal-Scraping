export interface PublicUser {
  id: string;
  username: string;
  email: string;
  isAdmin: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredUser extends PublicUser {
  passwordHash: string;
  cistUserId: string;
  encryptedCistPassword: string;
}

export interface PortalUserCredentials {
  id: string;
  cistUserId: string;
  cistPassword: string;
}

export interface StoredRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  replacedBy: string | null;
  createdAt: string;
}

export interface StoredPasskeyCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredWebAuthnChallenge {
  id: string;
  userId: string | null;
  challenge: string;
  type: "registration" | "authentication";
  expiresAt: string;
  createdAt: string;
}

export interface StoredInvite {
  id: string;
  codeHash: string;
  createdByUserId: string | null;
  expiresAt: string | null;
  usedByUserId: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface PublicInvite {
  id: string;
  createdByUserId: string | null;
  expiresAt: string | null;
  usedByUserId: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
