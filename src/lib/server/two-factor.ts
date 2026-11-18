import type { TwoFactor } from '#lib/db/models/index.ts';

import { getRequestEvent } from '$app/server';

import { createOTP } from '@better-auth/utils/otp';
import { error } from '@sveltejs/kit';
import {
  confirmPendingTwoFactor,
  deleteEnabledTwoFactor,
  replacePendingTwoFactor,
  replaceRecoveryCodes
} from '#queries/two-factor.ts';
import { APIError as BetterAuthAPIError } from 'better-auth/api';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import QRCode from 'qrcode';

import { getAuth } from '#lib/server/auth.ts';
import getDatabase from '#lib/server/database.ts';
import {
  markTwoFactorChallengeCompleted,
  requireEnabledTwoFactor,
  requirePendingTwoFactorSetup,
  requireTwoFactorSetup
} from '#lib/server/security.ts';

import { config } from '#config/server';

const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_SECRET_LENGTH = 32;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_LENGTH = 10;

export type TwoFactorSetup = {
  manualSetupKey: string;
  qrCodeSvg: string;
};

export type TwoFactorChallengeResult = 'completed' | 'exhausted' | 'expired' | 'failed' | 'invalid' | 'locked';

function failTwoFactorWrite(): never {
  error(500, 'Unable to update two-factor authentication.', { code: 'TWO_FACTOR_WRITE_FAILED' });
}

async function getSecretKey() {
  return (await getAuth().$context).secretConfig;
}

function isBetterAuthCode(err: unknown, code: string) {
  return err instanceof BetterAuthAPIError && err.body?.code === code;
}

function isExpiredChallenge(err: unknown) {
  return (
    isBetterAuthCode(err, 'INVALID_TWO_FACTOR_COOKIE') ||
    isBetterAuthCode(err, 'TOTP_NOT_ENABLED') ||
    isBetterAuthCode(err, 'BACKUP_CODES_NOT_ENABLED')
  );
}

async function encrypt(value: string) {
  return symmetricEncrypt({
    data: value,
    key: await getSecretKey()
  });
}

function createRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = generateRandomString(RECOVERY_CODE_LENGTH, 'a-z', '0-9', 'A-Z');
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

async function encryptRecoveryCodes(codes: string[]) {
  return encrypt(JSON.stringify(codes));
}

async function decryptRecoveryCodes(value: string) {
  const parsed = JSON.parse(
    await symmetricDecrypt({
      data: value,
      key: await getSecretKey()
    })
  ) as unknown;

  return Array.isArray(parsed) && parsed.every((code) => typeof code === 'string') ? parsed : [];
}

async function verifyCode(twoFactor: TwoFactor, code: string) {
  const secret = await symmetricDecrypt({
    data: twoFactor.secret,
    key: await getSecretKey()
  });

  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD }).verify(code);
}

export async function startSetup(): Promise<TwoFactorSetup> {
  const { user } = await requireTwoFactorSetup();

  const secret = generateRandomString(TOTP_SECRET_LENGTH);
  const totpURI = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD }).url(config.app.name, user.email);
  const recoveryCodes = createRecoveryCodes();
  const backupCodes = await encryptRecoveryCodes(recoveryCodes);
  const encryptedSecret = await encrypt(secret);
  const qrCodeSvg = await QRCode.toString(totpURI, {
    margin: 1,
    type: 'svg',
    width: 256
  });

  const inserted = await replacePendingTwoFactor(getDatabase(), user.id, encryptedSecret, backupCodes).catch(
    failTwoFactorWrite
  );
  if (!inserted) {
    error(409, 'Two-factor authentication setup changed. Reload security settings and try again.');
  }

  return {
    manualSetupKey: new URL(totpURI).searchParams.get('secret') ?? '',
    qrCodeSvg
  };
}

export async function confirmSetup(code: string): Promise<boolean> {
  const { session, twoFactor } = await requirePendingTwoFactorSetup();

  if (!(await verifyCode(twoFactor, code))) {
    return false;
  }

  const confirmed = await confirmPendingTwoFactor(getDatabase(), twoFactor, session.token, new Date()).catch(
    failTwoFactorWrite
  );
  if (!confirmed) {
    error(409, 'Two-factor authentication setup changed. Reload security settings and try again.');
  }

  return true;
}

export async function verifyTotpChallenge(code: string): Promise<TwoFactorChallengeResult> {
  const { request } = getRequestEvent();

  try {
    const result = await getAuth().api.verifyTOTP({
      body: { code },
      headers: request.headers
    });

    await markTwoFactorChallengeCompleted(result.token);
    return 'completed';
  } catch (err) {
    if (isExpiredChallenge(err)) return 'expired';
    if (isBetterAuthCode(err, 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE')) return 'exhausted';
    if (isBetterAuthCode(err, 'ACCOUNT_TEMPORARILY_LOCKED')) return 'locked';
    if (isBetterAuthCode(err, 'INVALID_CODE')) return 'invalid';

    console.error('Failed to complete TOTP challenge:', err);
    return 'failed';
  }
}

export async function verifyRecoveryChallenge(code: string): Promise<TwoFactorChallengeResult> {
  const { request } = getRequestEvent();

  try {
    const result = await getAuth().api.verifyBackupCode({
      body: { code },
      headers: request.headers
    });

    if (result.token) {
      await markTwoFactorChallengeCompleted(result.token);
    }

    return 'completed';
  } catch (err) {
    if (isExpiredChallenge(err)) return 'expired';
    if (isBetterAuthCode(err, 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE')) return 'exhausted';
    if (isBetterAuthCode(err, 'ACCOUNT_TEMPORARILY_LOCKED')) return 'locked';
    if (isBetterAuthCode(err, 'INVALID_BACKUP_CODE')) return 'invalid';

    console.error('Failed to complete recovery challenge:', err);
    return 'failed';
  }
}

export async function disable() {
  const { session, twoFactor } = await requireEnabledTwoFactor();
  const deleted = await deleteEnabledTwoFactor(getDatabase(), twoFactor, session.token, new Date()).catch(
    failTwoFactorWrite
  );
  if (!deleted) {
    error(409, 'Two-factor authentication enrollment changed. Reload security settings and try again.');
  }
}

export async function getRecoveryCodes(): Promise<string[]> {
  const { twoFactor } = await requireEnabledTwoFactor();
  return decryptRecoveryCodes(twoFactor.backupCodes);
}

export async function regenerateRecoveryCodes(): Promise<string[]> {
  const { twoFactor } = await requireEnabledTwoFactor();
  const recoveryCodes = createRecoveryCodes();

  const backupCodes = await encryptRecoveryCodes(recoveryCodes);
  const updated = await replaceRecoveryCodes(getDatabase(), twoFactor, backupCodes).catch(failTwoFactorWrite);
  if (!updated) {
    error(409, 'Recovery codes changed. Reload security settings and try again.');
  }

  return recoveryCodes;
}
