-- ── A notification may address someone who has no email ──────────────────────────────────────────
--
-- `recipient_email` has been NOT NULL since 007, when email was the only channel and the column was
-- both the address AND the reason the row existed. Since then the row has grown SMS, WhatsApp and
-- push, and customer email has become OPTIONAL — but this constraint did not move, so the whole
-- notification set still hinged on it.
--
-- ⚠️ WHAT IT WAS ACTUALLY DOING. Not "email delivery is skipped". The five customer notify functions
-- return BEFORE inserting when there is no email (services/notifications.js), because they could not
-- have inserted anyway. So a customer with only a phone got NO NOTIFICATION AT ALL — no row, no bell,
-- no SMS, no WhatsApp, and nothing recorded to say anything had been withheld. Every channel we have
-- built for that customer was unreachable behind a column none of them use.
--
-- That customer is not an edge case. `POST /orders/manual` — a baker typing in a walk-in or a phone
-- call — requires `customer.phone` OR `customer.email`, so phone-only is the NORMAL shape there.
--
-- After this, `recipient_email` means exactly what 057 already called it: the EMAIL DELIVERY ADDRESS,
-- absent when there is no email to deliver to. It was never the owner of the row (`baker_id` is) and
-- it is not the identity of the recipient — the phone channels resolve their own contact from the
-- payload's orderId.
--
-- Nothing else needs a default or a backfill: every existing row has an address, and dropping a NOT
-- NULL neither rewrites the table nor invalidates an index.

ALTER TABLE notifications ALTER COLUMN recipient_email DROP NOT NULL;

COMMENT ON COLUMN notifications.recipient_email IS
  'Email delivery address, NULL when the recipient has no email. Not the owner of the row '
  '(baker_id is) and not the recipient''s identity: the SMS and WhatsApp channels resolve their '
  'own contact from the payload. NULL here means the email channel is skipped, not that the '
  'notification is undeliverable.';
