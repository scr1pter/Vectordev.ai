# Notifications spec

## 1 Email

`sendEmail` MUST retry at most 3 times.

The mail server MUST come from `SMTP_HOST`, never from a constant.

## 2 Digest

`buildDigest` MUST group events by account.

The daily digest is sent at the hour `DIGEST_HOUR_UTC` gives.
