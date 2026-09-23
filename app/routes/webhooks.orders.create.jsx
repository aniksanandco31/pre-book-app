import { authenticate } from "../shopify.server";

const PRE_BOOKED_TAG = "pre booked";
const PRE_ORDER_PROPERTY = "_Pre-order";

const graphql = async (admin, query, variables = {}) => {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  return json.data;
};

const getOrderGid = (payload) => {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload.id) return `gid://shopify/Order/${payload.id}`;

  return null;
};

const propertyMarksPreOrder = (property) => {
  if (!property) return false;

  const name = property.name ?? property.key;
  const value = property.value;

  return name === PRE_ORDER_PROPERTY && String(value).toLowerCase() === "true";
};

const lineItemMarksPreOrder = (lineItem) => {
  if (!lineItem) return false;

  if (Array.isArray(lineItem.properties)) {
    return lineItem.properties.some(propertyMarksPreOrder);
  }

  if (lineItem.properties && typeof lineItem.properties === "object") {
    return String(lineItem.properties[PRE_ORDER_PROPERTY]).toLowerCase() === "true";
  }

  return false;
};

const orderHasPreOrderLine = (payload) => {
  if (!Array.isArray(payload.line_items)) return false;

  return payload.line_items.some(lineItemMarksPreOrder);
};

export const action = async ({ request }) => {
  const { admin, payload, session, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin || !orderHasPreOrderLine(payload)) {
    return new Response();
  }

  const orderId = getOrderGid(payload);

  if (!orderId) {
    console.error(`Could not tag pre-booked order for ${shop}: missing order ID.`);
    return new Response();
  }

  try {
    const data = await graphql(
      admin,
      `#graphql
        mutation TagPreBookedOrder($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }`,
      {
        id: orderId,
        tags: [PRE_BOOKED_TAG],
      },
    );

    const userErrors = data.tagsAdd.userErrors ?? [];

    if (userErrors.length) {
      console.error(
        `Could not tag pre-booked order ${orderId} for ${shop}: ${userErrors
          .map((error) => error.message)
          .join(", ")}`,
      );
    }
  } catch (error) {
    console.error(
      `Could not tag pre-booked order ${orderId} for ${shop}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  return new Response();
};
