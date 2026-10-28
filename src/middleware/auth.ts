import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { serialize, parse } from 'cookie';
import { sessionCookieDomain } from './hosts';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE_NAME = 'bengals_admin_session';
const SESSION_EXPIRY = '15d';

export type AdminRole = 'super_admin' | 'admin';
export type AuthRole = 'super_admin' | 'admin' | 'member';

export interface AdminUser {
  username: string;
  passwordHash: string;
  role: AdminRole;
  createdAt: string;
}

export interface SessionPayload {
  userId: string;               // Player ID (unified for all roles)
  email: string;
  username?: string;            // Display name (for admins)
  role: AuthRole;               // Authentication role (super_admin, admin, or member)
  iat?: number;
  exp?: number;
}

/**
 * Hash a password using bcrypt
 * @param password - Plain text password
 * @returns Hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

/**
 * Verify a password against a hash
 * @param password - Plain text password
 * @param hash - Hashed password to compare against
 * @returns True if password matches
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

/**
 * Create a JWT session token
 * @param userId - User ID (player ID for all roles)
 * @param email - User email
 * @param role - Authentication role (super_admin, admin, or member)
 * @param username - Optional username (for admins)
 * @returns JWT token string
 */
export function createSession(
  userId: string,
  email: string,
  role: AuthRole,
  username?: string
): string {
  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is not set');
  }

  const payload: SessionPayload = { userId, email, role, username };
  return jwt.sign(payload, SESSION_SECRET, { expiresIn: SESSION_EXPIRY });
}

/**
 * Validate a JWT session token
 * @param token - JWT token string
 * @returns Session payload if valid, null if invalid
 */
export function validateSession(token: string): SessionPayload | null {
  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is not set');
  }

  try {
    const payload = jwt.verify(token, SESSION_SECRET) as SessionPayload;
    return payload;
  } catch (error) {
    return null;
  }
}

/**
 * Create a session cookie
 * @param token - JWT token
 * @param isProduction - Whether running in production
 * @returns Serialized cookie string
 */
export function createSessionCookie(
  token: string,
  isProduction: boolean = false,
  domain?: string
): string {
  return serialize(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 15, // 15 days
    path: '/',
    domain,
  });
}

/**
 * Clear the session cookie
 * @param isProduction - Whether running in production
 * @param domain - Cookie domain to clear (omit for the host-only cookie)
 * @returns Serialized cookie string that clears the cookie
 */
export function clearSessionCookie(isProduction: boolean = false, domain?: string): string {
  return serialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
    domain,
  });
}

/**
 * Set-Cookie headers for a login. On goldenstatecc.org hosts the cookie is
 * shared with the admin subdomain, and any older host-only cookie is cleared
 * so the browser doesn't keep sending a stale session alongside it.
 */
export function loginCookies(token: string, isProduction: boolean, host: string | undefined): string[] {
  const domain = sessionCookieDomain(host);
  const cookies = [createSessionCookie(token, isProduction, domain)];
  if (domain) cookies.push(clearSessionCookie(isProduction));
  return cookies;
}

/** Set-Cookie headers for a logout: both the shared and the host-only cookie */
export function logoutCookies(isProduction: boolean, host: string | undefined): string[] {
  const domain = sessionCookieDomain(host);
  const cookies = [clearSessionCookie(isProduction)];
  if (domain) cookies.push(clearSessionCookie(isProduction, domain));
  return cookies;
}

/**
 * Extract session token from cookie header
 * @param cookieHeader - Cookie header string
 * @returns Session token if found, null otherwise
 */
export function extractSessionFromCookie(cookieHeader: string): string | null {
  const cookies = parse(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] || null;
}

/**
 * Validate admin session from cookie header
 * @param cookieHeader - Cookie header string
 * @returns Session payload if valid, null if invalid
 */
export function validateAdminSession(
  cookieHeader: string | undefined
): SessionPayload | null {
  if (!cookieHeader) {
    return null;
  }

  const token = extractSessionFromCookie(cookieHeader);
  if (!token) {
    return null;
  }

  return validateSession(token);
}

/**
 * Strip the password hash before a player record leaves the server.
 * `hasPassword` tells admin pages whether the player has a member login.
 */
export function withoutPasswordHash<T extends { passwordHash?: string }>(
  player: T
): Omit<T, 'passwordHash'> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = player;
  return { ...rest, hasPassword: !!passwordHash };
}

// ============================================================================
// Role-Based Authorization Helpers
// ============================================================================

/**
 * Check if session has super_admin role
 * @param session - Session payload
 * @returns True if user is super admin
 */
export function isSuperAdmin(session: SessionPayload | null): boolean {
  return session?.role === 'super_admin';
}

/**
 * Check if session has admin or super_admin role
 * @param session - Session payload
 * @returns True if user is admin or super admin
 */
export function isAdmin(session: SessionPayload | null): boolean {
  return session?.role === 'super_admin' || session?.role === 'admin';
}

/**
 * Check if session has any authenticated role (member, admin, or super_admin)
 * @param session - Session payload
 * @returns True if user is authenticated with any role
 */
export function isMember(session: SessionPayload | null): boolean {
  if (!session) return false;
  return ['super_admin', 'admin', 'member'].includes(session.role);
}

/**
 * Check if session meets required role level
 * @param session - Session payload
 * @param requiredRole - Required role level
 * @returns True if user has required role or higher
 */
export function requireRole(
  session: SessionPayload | null,
  requiredRole: AuthRole
): boolean {
  if (!session) return false;

  const roleHierarchy: Record<AuthRole, number> = {
    super_admin: 3,
    admin: 2,
    member: 1,
  };

  return roleHierarchy[session.role] >= roleHierarchy[requiredRole];
}
