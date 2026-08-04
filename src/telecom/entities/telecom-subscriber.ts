/**
 * Telecom subscriber entity — the simulation's subscriber model.
 *
 * Structurally mirrors a real Indian telecom operator's HLR/HSS subscriber
 * record (see the canonical C-DOT samples for IMSI / MSISDN / LAC / Cell ID /
 * RAT). Every value is synthetic, but the shape, ranges and internal
 * consistency (a subscriber's RAT matches its attached tower, last_seen is
 * within 48h, IMSI/MSISDN/IMEI are structurally valid) follow production
 * telecom standards so the sim behaves like the real subscriber database.
 */

export const TELECOM_TECHNOLOGIES = ['GSM', 'UMTS', 'LTE', 'NR5G'] as const;
export type TelecomTechnology = (typeof TELECOM_TECHNOLOGIES)[number];

export const SUBSCRIBER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export const REGISTRATION_STATES = ['REGISTERED', 'ATTACHED', 'DETACHED'] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

export const PAGING_STATES = ['IDLE', 'CONNECTED'] as const;
export type PagingState = (typeof PAGING_STATES)[number];

export const ROAMING_STATES = ['HOME', 'ROAMING'] as const;
export type RoamingState = (typeof ROAMING_STATES)[number];

export interface TelecomSubscriber {
  /** Database row id (UUID). */
  id: string;
  /** IMSI — MCC 404/405 + MNC + MSIN, 15 digits, unique. */
  imsi: string;
  /** MSISDN in E.164 international form without '+', e.g. 919868419126. */
  msisdn: string;
  /** IMEI — 15 digits, Luhn-valid, unique. */
  imei: string;
  /** Temporary mobile subscriber identity (hex). */
  tmsi?: string;
  /** Cell the subscriber is currently attached to. */
  cellId: string;
  /** Site id of the cell (see TelecomCellTower.siteId). */
  towerId: string;
  /** Last known cell before handover, when present. */
  previousCellId?: string;
  /** Location area code (LAC), e.g. 0451. */
  lac: string;
  /** Tracking area code (LTE/NR). */
  tac?: string;
  rncId?: string;
  enbId?: string;
  gnbId?: string;
  sectorId?: string;
  /** Radio access technology — must match the attached tower's technology. */
  technology: TelecomTechnology;
  status: SubscriberStatus;
  /** Attach time (HH:MM of attach), ISO timestamp. */
  attachTime: Date;
  /** Last seen — always within the previous 48 hours. */
  lastSeen: Date;
  /** GSM/UMTS signal strength in dBm. */
  signalRssi?: number;
  /** LTE/5G reference signal received power in dBm. */
  rsrp?: number;
  /** LTE/5G reference signal received quality in dB. */
  rsrq?: number;
  /** Signal to interference + noise ratio in dB. */
  sinr?: number;
  roamingStatus: RoamingState;
  emergencyCapable: boolean;
  volteEnabled: boolean;
  vonrEnabled: boolean;
  deviceVendor?: string;
  deviceModel?: string;
  simOperator?: string;
  homePlmn?: string;
  visitedPlmn?: string;
  apn?: string;
  ipv4?: string;
  ipv6?: string;
  registrationState: RegistrationState;
  pagingState?: PagingState;
  mcc?: string;
  mnc?: string;
  operator?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The columns TURANT actually needs to join a subscriber to an alert. */
export type SubscriberKey = Pick<
  TelecomSubscriber,
  'id' | 'imsi' | 'msisdn' | 'cellId' | 'towerId' | 'lac' | 'technology' | 'status' | 'lastSeen'
>;
