# Billing spec

## 1 Invoices

`createInvoice` MUST store every amount in integer cents.

Every invoice number comes from `InvoiceNumberer` and MUST never be reused.

POST /v1/invoices creates an invoice and returns 201.

## 2 Refunds

`issueRefund` MUST name the invoice it reverses.

Refunds are allowed for at most 30 days after payment, as `REFUND_WINDOW_DAYS` sets.

## 3 Tax

`computeTax` MUST round half to even.

## 4 Payment events

POST /v1/payments/events MUST reject a request whose signature header does not match.
