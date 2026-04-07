import {
  decryptBufferFromStorage,
  encryptBufferForStorage,
  rewrapStorageEncryptionMetadata,
  type StorageEncryptionMetadata,
} from "./encryption.js";

export interface DeliveryLogMetadataValue {
  envelopeFrom: string | null;
  headerFrom: string | null;
  subject: string | null;
}

export interface DeliveryLogMetadataColumns {
  envelopeFrom: string | null;
  headerFrom: string | null;
  subject: string | null;
  metadataCiphertext: string | null;
  metadataEncryptionMode: StorageEncryptionMetadata["encryptionMode"];
  metadataWrappedDek: string | null;
  metadataKekKeyId: string | null;
  metadataEncryptedAt: Date | null;
}

export interface DeliveryLogMetadataRecord extends DeliveryLogMetadataColumns {
  id: string;
}

interface SerializedDeliveryLogMetadata {
  envelopeFrom: string | null;
  headerFrom: string | null;
  subject: string | null;
}

export async function prepareDeliveryLogMetadataWrite(
  deliveryLogId: string,
  value: DeliveryLogMetadataValue,
): Promise<DeliveryLogMetadataColumns> {
  const payload = Buffer.from(JSON.stringify(normalizeMetadata(value)), "utf-8");
  const { blob, metadata } = await encryptBufferForStorage(payload, metadataAad(deliveryLogId));

  if (metadata.encryptionMode === "none") {
    return {
      envelopeFrom: value.envelopeFrom,
      headerFrom: value.headerFrom,
      subject: value.subject,
      metadataCiphertext: null,
      metadataEncryptionMode: "none",
      metadataWrappedDek: null,
      metadataKekKeyId: null,
      metadataEncryptedAt: null,
    };
  }

  return {
    envelopeFrom: null,
    headerFrom: null,
    subject: null,
    metadataCiphertext: blob.toString("base64"),
    metadataEncryptionMode: metadata.encryptionMode,
    metadataWrappedDek: metadata.wrappedDek,
    metadataKekKeyId: metadata.kekKeyId,
    metadataEncryptedAt: metadata.encryptedAt,
  };
}

export async function readDeliveryLogMetadata(
  record: DeliveryLogMetadataRecord,
): Promise<DeliveryLogMetadataValue> {
  if ((record.metadataEncryptionMode ?? "none") === "none") {
    return {
      envelopeFrom: record.envelopeFrom,
      headerFrom: record.headerFrom,
      subject: record.subject,
    };
  }

  if (record.metadataEncryptionMode !== "local-v1") {
    throw new Error(
      `Unsupported delivery-log metadata encryption mode: ${record.metadataEncryptionMode}`,
    );
  }

  if (!record.metadataCiphertext) {
    throw new Error("Encrypted delivery-log metadata is missing ciphertext");
  }

  const plaintext = await decryptBufferFromStorage(
    Buffer.from(record.metadataCiphertext, "base64"),
    {
      encryptionMode: record.metadataEncryptionMode,
      wrappedDek: record.metadataWrappedDek,
      kekKeyId: record.metadataKekKeyId,
    },
    metadataAad(record.id),
  );
  return parseMetadataPayload(plaintext);
}

export async function backfillDeliveryLogMetadata(
  record: DeliveryLogMetadataRecord,
): Promise<DeliveryLogMetadataColumns> {
  if ((record.metadataEncryptionMode ?? "none") !== "none") {
    return {
      envelopeFrom: record.envelopeFrom,
      headerFrom: record.headerFrom,
      subject: record.subject,
      metadataCiphertext: record.metadataCiphertext,
      metadataEncryptionMode: record.metadataEncryptionMode,
      metadataWrappedDek: record.metadataWrappedDek,
      metadataKekKeyId: record.metadataKekKeyId,
      metadataEncryptedAt: record.metadataEncryptedAt,
    };
  }

  return prepareDeliveryLogMetadataWrite(record.id, {
    envelopeFrom: record.envelopeFrom,
    headerFrom: record.headerFrom,
    subject: record.subject,
  });
}

export async function rewrapDeliveryLogMetadata(
  record: DeliveryLogMetadataRecord,
): Promise<Pick<DeliveryLogMetadataColumns, "metadataWrappedDek" | "metadataKekKeyId">> {
  if ((record.metadataEncryptionMode ?? "none") !== "local-v1") {
    return {
      metadataWrappedDek: record.metadataWrappedDek,
      metadataKekKeyId: record.metadataKekKeyId,
    };
  }

  const rewrapped = await rewrapStorageEncryptionMetadata({
    encryptionMode: "local-v1",
    wrappedDek: record.metadataWrappedDek,
    kekKeyId: record.metadataKekKeyId,
    encryptedAt: record.metadataEncryptedAt,
  });
  return {
    metadataWrappedDek: rewrapped.wrappedDek,
    metadataKekKeyId: rewrapped.kekKeyId,
  };
}

function metadataAad(deliveryLogId: string): string {
  return `delivery-log-meta:${deliveryLogId}`;
}

function normalizeMetadata(value: DeliveryLogMetadataValue): SerializedDeliveryLogMetadata {
  return {
    envelopeFrom: value.envelopeFrom ?? null,
    headerFrom: value.headerFrom ?? null,
    subject: value.subject ?? null,
  };
}

function parseMetadataPayload(payload: Buffer): DeliveryLogMetadataValue {
  const decoded = JSON.parse(payload.toString("utf-8")) as Partial<SerializedDeliveryLogMetadata>;

  return {
    envelopeFrom: normalizeStringField(decoded.envelopeFrom),
    headerFrom: normalizeStringField(decoded.headerFrom),
    subject: normalizeStringField(decoded.subject),
  };
}

function normalizeStringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
