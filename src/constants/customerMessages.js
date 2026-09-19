// ── What the baker is choosing between, and what each message looks like ─────────────────────────
//
// The catalogue behind Settings → Customer updates: which customer notifications can be paid for,
// what each one costs in messages, and the words a customer would actually receive.
//
// ⚠️ THE PREVIEW TEXT MUST MATCH THE APPROVED META TEMPLATE, AND NOTHING ENFORCES THAT. The body a
// customer receives lives at Meta — approved there, uneditable afterwards, and not readable from any
// API we hold. So this is a COPY, and a copy can drift. It is here rather than in the UI because one
// wrong copy is fixable and five are not, and because the preview is the whole reason a baker can be
// charged for this at all: they see the real message, sender included, and decide. A preview that has
// drifted from the template is worse than no preview, so:
//
//   ⚠️ CHANGING A TEMPLATE AT META MEANS CHANGING THE TEXT HERE, IN THE SAME SITTING.
//   The templates are specified in spattoo-docs/plans/whatsapp-templates.md — that file and this
//   constant are the two places, and they are checked against each other by check:message-previews.
//
// `sender` is shown deliberately. A baker paying for a message their customer sees branded SPATOO
// should see that before they pay, not after (plans/whose-name-is-on-the-message.md).

/* ⚠️ ORDERED BY THE ORDER'S OWN LIFECYCLE, not by which are recommended.
 *
 * The first cut led with the two switched on by default — "Quote sent" then "Order ready" — which put
 * "Order received" third, after a message that can only follow it. A baker reads this list to picture
 * what their customer will receive across one order, and a sequence that cannot happen makes that
 * impossible.
 *
 * The sequence is `order_statuses` (supabase/order_status_surrogate.sql), not a guess:
 *   requested 20 → quoted 30 → confirmed 40 → in_production 50 → ready 60 → completed 70
 *
 * "Design updated" has no status of its own — it repeats while the design moves — so it sits where it
 * happens, between confirmed and ready. The RECOMMENDED badge still marks the two defaults; it does
 * not need to reorder them to do that. */
export const CUSTOMER_MESSAGE_EVENTS = [
  {
    slug: 'order_placed_customer',
    image: true,
    label: 'Order received',
    when: 'When you write down an order for a customer yourself',
    recommended: false,
    messages: 1,
    /* ⚠️ THIS IS A CONFIRMATION, NOT AN ANNOUNCEMENT. It goes to someone who gave their order over a
       counter or a phone — they know an order exists; what they cannot check is whether the baker
       wrote it down correctly. An earlier version said only "has started an order for you", which
       tells them nothing they did not already know and nothing they could correct. So it reads back
       what was taken: size, flavour, and when.

       ⚠️ "Received" is idiomatic here even though the customer SENT nothing — they spoke to the baker
       at a counter or on the phone. It carries slightly less of the message's job than "written down"
       did, which hinted the baker might have got it wrong; the closing line does that work instead,
       so do not drop it.

       Every field here is never-null by construction (readableOrderFields) — a sparse order reads
       "Size: Not given / Flavour: Not chosen / Pickup: No date given", which is honest and is itself
       a prompt to get in touch. A blank would make Meta reject the whole send. */
    body: 'Hi Asha, {bakery} has received your cake order.\n\n'
        + 'Size: 1.5 kg\n'
        + 'Flavour: Chocolate, Vanilla\n'
        + 'Home delivery: 20 September 2026, 2:30 PM\n\n'
        + 'Tap below to check everything is right and add your email for updates.',
    button: 'View order',
  },
  {
    slug: 'quote_issued_customer',
    // Image header — table A in plans/whatsapp-templates.md. Drives the preview only.
    image: true,
    label: 'Quote sent',
    when: 'As soon as you send a quote',
    // ⚠️ Recommended, and the UI says why rather than just ticking it: a quote nobody sees is an
    // order that quietly dies, and the baker never learns it was the message that failed.
    recommended: true,
    messages: 1,
    body: 'Hi Asha, {bakery} has sent you a quote for your cake: Rs. 1,499.\n\n'
        + 'Tap below to see the details and accept it.',
    button: 'View quote',
  },
  {
    slug: 'order_confirmed_customer',
    label: 'Order confirmed',
    when: 'When you confirm an order',
    recommended: false,
    messages: 1,
    body: 'Hi Asha, your cake order with {bakery} is confirmed. Total: Rs. 1,499.\n\n'
        + 'Tap below to see your order.',
    button: 'View order',
  },
  {
    slug: 'design_updated_customer',
    label: 'Design updated',
    when: 'Each time you change a design',
    recommended: false,
    // ⚠️ The only one that can fire more than once on a single order, which is exactly what a baker
    // needs to know before ticking it — the others cost one message and are done.
    messages: 1,
    repeats: true,
    body: 'Hi Asha, {bakery} has updated the design for your cake.\n\n'
        + 'Tap below to take a look.',
    button: 'View design',
  },
  {
    slug: 'order_ready_customer',
    image: true,
    label: 'Order ready',
    when: 'When you mark an order ready',
    recommended: true,
    messages: 1,
    body: 'Hi Asha, your cake from {bakery} is ready.\n\n'
        + 'Pickup: 20 September 2026, 2:30 PM',
    button: null,
  },
  {
    slug: 'order_completed_customer',
    label: 'Thank you',
    when: 'When you mark an order complete',
    recommended: false,
    messages: 1,
    body: 'Thank you for ordering from {bakery}, Asha. We hope your cake made the moment special.\n\n'
        + 'Wishing you many more celebrations.',
    button: null,
  },
];

// What the customer sees in the "from" line. Not a per-baker value today — see
// plans/whose-name-is-on-the-message.md for why a baker's own sender is not available in this market.
export const MESSAGE_SENDER = 'Spattoo';
