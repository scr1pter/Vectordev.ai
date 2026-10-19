# Uploads spec

## 1 Limits

Uploads are limited to at most 50 MB per file by `MAX_UPLOAD_BYTES`.

## 2 Scanning

`scanUpload` MUST run before a file is stored.

## 3 Storage

`storeObject` MUST write to the bucket that `UPLOAD_BUCKET` names.

DELETE /v1/uploads/{id} MUST remove the stored object as well.
