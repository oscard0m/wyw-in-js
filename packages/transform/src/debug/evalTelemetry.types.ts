export const EVAL_TELEMETRY_SCHEMA_VERSION = 2 as const;

export const EVAL_PREPARATION_ARTIFACT_LIMIT = 128;

export type EvalRootStatus = 'error' | 'no-values' | 'success';

export type EvalOnlyShape = 'empty' | 'named' | 'wildcard';

export type EvalPreparationStage = 'prepare' | 'shake' | 'strip';

export type EvalLoadCacheOutcome =
  | 'hit'
  | 'inflight-hit'
  | 'inflight-wait'
  | 'inflight-wait-miss'
  | 'invalidation-miss'
  | 'miss'
  | 'promotion'
  | 'serialized-exports';

export type EvalLoadResendReason =
  | 'hash-change'
  | 'invalidation'
  | 'only-widening'
  | 'storage-shape-change';

export type EvalLoadTransmission = {
  /** Physical messages carrying `codeChunk`; zero for an unchunked result. */
  chunks?: number;
  /** Code supplied in the logical LOAD_RESULT. An empty string is a payload. */
  code?: string;
  /** Successfully written code bytes for an incomplete chunked response. */
  codeBytes?: number;
  /** True when the logical response did not finish writing. */
  incomplete?: boolean;
  /** One for a normal result, greater than one only if callers coalesce work. */
  logicalResults?: number;
  mode: 'error' | 'initial' | 'omission' | 'resend' | 'serialized-exports';
  /** True when the logical result instructs the runner to reset this module. */
  moduleReset?: boolean;
  resendReason?: EvalLoadResendReason;
  /** Number of physical LOAD_RESULT messages written for the logical result. */
  wireMessages: number;
  /** UTF-8 bytes measured from the already serialized wire messages. */
  wireBytes: number;
};

export type EvalPreparedCacheEviction = {
  id: string;
  knownCodeBytes?: number;
  reason: 'capacity' | 'invalidation' | 'replacement';
};

export type EvalPressureProxy = {
  count?: number;
  store: 'primary' | 'variant';
  type: 'shipment-hash-change';
};

export type EvalRunnerSignal =
  | {
      type: 'modules-reset';
    }
  | {
      ids: readonly string[];
      type: 'poison-ids';
    };

export type EvalBrokerMirrorSnapshot = {
  entries: number;
  knownCodeBytes: number;
  unknownByteEntries: number;
};

export type EvalPreparationResult = {
  code: string;
  imports: ReadonlyMap<string, readonly string[]> | null;
  only: readonly string[];
  outputRevision: string;
};

export type EvalPreparationArtifact = {
  calls: number;
  durationMs: number;
  errors: number;
  id: string;
  importMapBytes: number;
  onlyShape: EvalOnlyShape;
  outputRevision: string | null;
  prepareCalls: number;
  prepareMs: number;
  preparedCodeBytes: number;
  shakeCalls: number;
  shakeMs: number;
  stripCalls: number;
  stripMs: number;
};

export type EvalTelemetryRootRecord = {
  brokerId: number;
  evictions: {
    brokerObservedPoisonIds: number;
    brokerObservedPoisonSignals: number;
    brokerObservedResetSignals: number;
    hostPreparedCache: {
      capacity: number;
      invalidation: number;
      knownCodeBytes: number;
      replacement: number;
      total: number;
      unknownByteEntries: number;
    };
    primaryPressureProxy: {
      shipmentHashChanges: number;
    };
    variantPressureProxy: {
      shipmentHashChanges: number;
    };
  };
  loads: {
    cache: {
      hits: number;
      inflightHits: number;
      inflightWaitMisses: number;
      inflightWaits: number;
      invalidationMisses: number;
      misses: number;
      outcomes: Record<EvalLoadCacheOutcome, number>;
      promotions: number;
      serializedExports: number;
    };
    preparation: {
      artifacts: EvalPreparationArtifact[];
      calls: number;
      droppedArtifacts: number;
      durationMs: number;
      errors: number;
      importMapBytes: number;
      prepareCalls: number;
      prepareMs: number;
      preparedCodeBytes: number;
      shakeCalls: number;
      shakeMs: number;
      stripCalls: number;
      stripMs: number;
    };
    requests: number;
    transmission: {
      chunkedResults: number;
      chunks: number;
      codeBytes: number;
      emptyCodePayloads: number;
      errors: number;
      incompleteResults: number;
      initial: number;
      logicalResults: number;
      moduleResetSignals: number;
      omissions: number;
      resendReasons: Record<EvalLoadResendReason, number>;
      resends: number;
      serializedExports: number;
      wireBytes: number;
      wireMessages: number;
    };
  };
  mirror: EvalBrokerMirrorSnapshot;
  root: {
    batchIndex: number;
    batchSize: number;
    durationMs: number;
    entrypoint: string;
    queueWaitMs: number;
    status: EvalRootStatus;
  };
  schemaVersion: typeof EVAL_TELEMETRY_SCHEMA_VERSION;
  type: 'eval-root';
};

export type EvalBrokerLifecycleEvent =
  | 'broker-created'
  | 'broker-dispose-observed'
  | 'broker-reused'
  | 'runner-activated'
  | 'runner-exit-observed'
  | 'runner-spawn-attempt'
  | 'runner-stop-requested';

export type EvalBrokerLifecycleMetadata = {
  event: EvalBrokerLifecycleEvent;
  reason: string;
  mirror?: EvalBrokerMirrorSnapshot;
};

export type EvalTelemetryLifecycleRecord = EvalBrokerLifecycleMetadata & {
  brokerId: number;
  observedAtMs: number;
  restartInferred: boolean;
  schemaVersion: typeof EVAL_TELEMETRY_SCHEMA_VERSION;
  type: 'eval-lifecycle';
};

export type EvalTelemetryRecord =
  | EvalTelemetryLifecycleRecord
  | EvalTelemetryRootRecord;

export type EvalPreparationToken = {
  fail: () => void;
  finish: (result: EvalPreparationResult) => void;
  measureStage: <T>(stage: EvalPreparationStage, callback: () => T) => T;
};

export type EvalTelemetryToken = {
  beginPreparation: (
    id: string,
    only: readonly string[]
  ) => EvalPreparationToken;
  finish: (status: EvalRootStatus, mirror?: EvalBrokerMirrorSnapshot) => void;
  recordLoadCacheOutcome: (outcome: EvalLoadCacheOutcome) => void;
  recordLoadRequest: () => void;
  recordLoadTransmission: (transmission: EvalLoadTransmission) => void;
  recordPreparedCacheEviction: (eviction: EvalPreparedCacheEviction) => void;
  recordPressureProxy: (proxy: EvalPressureProxy) => void;
  recordRunnerSignal: (signal: EvalRunnerSignal) => void;
  start: (batch: { batchIndex: number; batchSize: number }) => void;
};
