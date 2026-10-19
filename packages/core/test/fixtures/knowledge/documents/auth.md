# Auth spec

## 1 Sessions

The `refreshTokenTtl` MUST be 14 days.

`rotateRefreshToken` MUST invalidate the previous token at once.

## 2 Passwords

`hashPassword` MUST use a salt of its own for every account.

Passwords are at least 12 characters long, as `PASSWORD_MIN_LENGTH` sets.

## 3 Lockout

After `MAX_LOGIN_ATTEMPTS` failed sign-ins in a row the account MUST be locked for 15 minutes.

## 4 Users API

GET /v1/users/{id} returns 404 when the user does not exist.
