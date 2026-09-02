# Slice/01 - pizza demo brief

## Goal

Inside WebMCP Computer, build a polished pizza-ordering page that humans and agents operate
through one shared cart. This is a local demo: no network, payment, or real order.

## Build

- Create `~/pizza-demo/index.html`; use plain HTML, CSS, and JavaScript.
- Show Slice/01 branding, three menu cards, size selection, cart, total, receipt, and
  visible agent-activity line.
- Menu: Margherita (14/19 USD), Pepperoni (17/23), Night Mushroom (18/24), small/large.
- Human buttons and agent tools must update the same in-page state.

## Dynamic WebMCP tools

Register these from the served page with `document.modelContext.registerTool(...)`:

- `site_menu_get {}` - return stable IDs, descriptions, sizes, and prices.
- `site_pizza_add {pizza_id, size, quantity}` - add 1-8 pizzas to visible cart.
- `site_cart_get {}` - return line items, item count, USD total, and currency.
- `site_order_place {label?}` - create local demo order ID, status, ETA, and receipt.

Use strict JSON schemas with `additionalProperties: false`. Tool descriptions must say
what changes and that placing an order sends nothing externally. Each executor returns
structured JSON and visibly updates shared UI. Tools exist only while Preview is open.

## Done

1. Run `serve pizza-demo/`.
2. Preview renders cleanly and console has no errors.
3. Four `site_*` tools appear dynamically.
4. Agent can read menu, add one large pepperoni, read a 23 USD cart, and place a demo
   order whose ID and ETA appear in receipt.
5. Leave Preview served for human handoff.
