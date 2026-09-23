import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const PREORDER_METAFIELD = {
  namespace: "pre_order",
  key: "settings",
};

const PURCHASE_OPTION_ACCESS_ERROR =
  "Shopify blocked pre-order setup because this app install does not have purchase option access yet. Restart `shopify app dev`, approve the updated scopes, then try again. If this is a production app, Shopify may need to approve purchase option permissions.";

const parseSettings = (value) => {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const parseProductIds = (formData, fallbackProductId) => {
  const rawProductIds = formData.get("productIds")?.toString();

  if (rawProductIds) {
    try {
      const productIds = JSON.parse(rawProductIds);

      if (Array.isArray(productIds)) {
        return productIds.filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  return fallbackProductId ? [fallbackProductId] : [];
};

const graphql = async (admin, query, variables = {}) => {
  let response;

  try {
    response = await admin.graphql(query, { variables });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Shopify API request failed.");
  }

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  return json.data;
};

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const data = await graphql(
    admin,
    `#graphql
      query ProductsForPreOrder {
        products(first: 50, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              handle
              status
              featuredMedia {
                preview {
                  image {
                    url
                    altText
                  }
                }
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    displayName
                    price
                  }
                }
              }
              preorderSettings: metafield(namespace: "pre_order", key: "settings") {
                value
              }
            }
          }
        }
      }`,
  );

  return {
    products: data.products.edges.map(({ node }) => {
      const variant = node.variants.edges[0]?.node;

      return {
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        image: node.featuredMedia?.preview?.image ?? null,
        variant,
        settings: parseSettings(node.preorderSettings?.value),
      };
    }),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const fallbackProductId = formData.get("productId")?.toString();
  const productIds = parseProductIds(formData, fallbackProductId);
  const productTitles = formData.getAll("productTitles").map((title) => title.toString());
  const ruleName = formData.get("ruleName")?.toString() || "Pre-order rule";
  const intent = formData.get("intent")?.toString();
  const sellingPlanGroupIdToDelete = formData.get("sellingPlanGroupId")?.toString();
  const depositType = formData.get("depositType")?.toString();
  const depositValue = Number(formData.get("depositValue"));
  const balanceDueDays = Number(formData.get("balanceDueDays"));
  const disabled = intent === "disable";
  const deleting = intent === "delete";

  if (productIds.length === 0) {
    return { ok: false, error: "Choose at least one product." };
  }

  if (deleting) {
    if (sellingPlanGroupIdToDelete) {
      const sellingPlanDeleteData = await graphql(
        admin,
        `#graphql
          mutation DeletePreOrderSellingPlan($id: ID!) {
            sellingPlanGroupDelete(id: $id) {
              deletedSellingPlanGroupId
              userErrors {
                field
                message
              }
            }
          }`,
        {
          id: sellingPlanGroupIdToDelete,
        },
      );

      const sellingPlanErrors = sellingPlanDeleteData.sellingPlanGroupDelete.userErrors ?? [];

      if (sellingPlanErrors.length) {
        return { ok: false, error: sellingPlanErrors.map((error) => error.message).join(", ") };
      }
    }

    const metafieldDeleteData = await graphql(
      admin,
      `#graphql
        mutation DeletePreOrderSettings($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }`,
      {
        metafields: productIds.map((productId) => ({
          ownerId: productId,
          namespace: PREORDER_METAFIELD.namespace,
          key: PREORDER_METAFIELD.key,
        })),
      },
    );

    const metafieldDeleteErrors = metafieldDeleteData.metafieldsDelete.userErrors ?? [];

    if (metafieldDeleteErrors.length) {
      return { ok: false, error: metafieldDeleteErrors.map((error) => error.message).join(", ") };
    }

    return { ok: true, deleted: true, productCount: productIds.length };
  }

  if (disabled) {
    const metafieldData = await graphql(
      admin,
      `#graphql
        mutation DisablePreOrder($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }`,
      {
        metafields: productIds.map((productId) => ({
          ownerId: productId,
          namespace: PREORDER_METAFIELD.namespace,
          key: PREORDER_METAFIELD.key,
          type: "json",
          value: JSON.stringify({
            active: false,
            productId,
            ruleName,
            updatedAt: new Date().toISOString(),
          }),
        })),
      },
    );

    const userErrors = metafieldData.metafieldsSet.userErrors ?? [];

    if (userErrors.length) {
      return { ok: false, error: userErrors.map((error) => error.message).join(", ") };
    }

    return { ok: true, disabled: true, productCount: productIds.length };
  }

  if (!["percentage", "price"].includes(depositType)) {
    return { ok: false, error: "Choose percentage or fixed amount." };
  }

  if (!Number.isFinite(depositValue) || depositValue <= 0) {
    return { ok: false, error: "Enter a deposit greater than 0." };
  }

  if (depositType === "percentage" && depositValue > 100) {
    return { ok: false, error: "Percentage deposit cannot be more than 100." };
  }

  if (!Number.isFinite(balanceDueDays) || balanceDueDays < 1) {
    return { ok: false, error: "Balance due days must be at least 1." };
  }

  const checkoutCharge =
    depositType === "percentage"
      ? {
          type: "PERCENTAGE",
          value: { percentage: depositValue },
        }
      : {
          type: "PRICE",
          value: { fixedValue: depositValue.toFixed(2) },
        };

  const depositLabel =
    depositType === "percentage"
      ? `${depositValue}% deposit`
      : `${depositValue.toFixed(2)} deposit`;

  let sellingPlanData;

  try {
    sellingPlanData = await graphql(
      admin,
      `#graphql
        mutation CreatePreOrderSellingPlan($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput!) {
          sellingPlanGroupCreate(input: $input, resources: $resources) {
            sellingPlanGroup {
              id
              sellingPlans(first: 1) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        input: {
          name: ruleName,
          merchantCode: `pre-order-${ruleName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now()}`,
          options: ["Pre-order"],
          sellingPlansToCreate: [
            {
              name: "Pre-order",
              category: "PRE_ORDER",
              options: `${depositLabel}. Balance due ${balanceDueDays} days after checkout`,
              description: `Reserve this item today with a ${depositLabel}.`,
              billingPolicy: {
                fixed: {
                  checkoutCharge,
                  remainingBalanceChargeTrigger: "TIME_AFTER_CHECKOUT",
                  remainingBalanceChargeTimeAfterCheckout: `P${balanceDueDays}D`,
                },
              },
              deliveryPolicy: {
                fixed: {
                  fulfillmentTrigger: "ASAP",
                },
              },
              inventoryPolicy: {
                reserve: "ON_SALE",
              },
            },
          ],
        },
        resources: {
          productIds,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    return {
      ok: false,
      error: message.includes("sellingPlanGroupCreate") || message.includes("purchase_options")
        ? PURCHASE_OPTION_ACCESS_ERROR
        : message || "Shopify could not create the pre-order selling plan.",
    };
  }

  const result = sellingPlanData.sellingPlanGroupCreate;
  const userErrors = result.userErrors ?? [];

  if (userErrors.length) {
    return {
      ok: false,
      error: userErrors.map((error) => error.message).join(", "),
    };
  }

  const sellingPlanGroupId = result.sellingPlanGroup.id;
  const sellingPlanId = result.sellingPlanGroup.sellingPlans.edges[0]?.node.id;
  const sellingPlanNumericId = sellingPlanId?.split("/").pop();
  const updatedAt = new Date().toISOString();
  const baseSettings = {
    active: true,
    productIds,
    productTitles,
    ruleName,
    depositType,
    depositValue,
    balanceDueDays,
    sellingPlanGroupId,
    sellingPlanId,
    sellingPlanNumericId,
    updatedAt,
  };

  const metafieldData = await graphql(
    admin,
    `#graphql
      mutation SavePreOrderSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      metafields: productIds.map((productId) => ({
        ownerId: productId,
        namespace: PREORDER_METAFIELD.namespace,
        key: PREORDER_METAFIELD.key,
        type: "json",
        value: JSON.stringify({
          ...baseSettings,
          productId,
        }),
      })),
    },
  );

  const metafieldErrors = metafieldData.metafieldsSet.userErrors ?? [];

  if (metafieldErrors.length) {
    return {
      ok: false,
      error: metafieldErrors.map((error) => error.message).join(", "),
    };
  }

  return { ok: true, settings: baseSettings, productCount: productIds.length };
};

export default function Index() {
  const { products } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [ruleName, setRuleName] = useState("Pre-order rule");
  const [depositType, setDepositType] = useState("percentage");
  const [depositValue, setDepositValue] = useState(20);
  const [balanceDueDays, setBalanceDueDays] = useState(30);
  const isSubmitting = fetcher.state !== "idle";
  const activeProducts = products.filter((product) => product.settings?.active);
  const rules = useMemo(() => {
    const rulesByKey = new Map();

    for (const product of products) {
      if (!product.settings?.active) continue;

      const settings = product.settings;
      const key = settings.sellingPlanGroupId || settings.ruleName || product.id;
      const existingRule = rulesByKey.get(key);

      if (existingRule) {
        existingRule.products.push(product);
        continue;
      }

      rulesByKey.set(key, {
        key,
        ruleName: settings.ruleName || "Pre-order rule",
        depositType: settings.depositType,
        depositValue: settings.depositValue,
        balanceDueDays: settings.balanceDueDays,
        sellingPlanGroupId: settings.sellingPlanGroupId,
        products: [product],
      });
    }

    return Array.from(rulesByKey.values());
  }, [products]);
  const selectedProducts = useMemo(
    () => products.filter((product) => selectedProductIds.includes(product.id)),
    [products, selectedProductIds],
  );
  const allSelected = products.length > 0 && selectedProductIds.length === products.length;

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show(
        fetcher.data.deleted
          ? `Pre-order rule deleted for ${fetcher.data.productCount} product${fetcher.data.productCount === 1 ? "" : "s"}`
          : fetcher.data.disabled
          ? `Pre-order disabled for ${fetcher.data.productCount} product${fetcher.data.productCount === 1 ? "" : "s"}`
          : `Pre-order rule created for ${fetcher.data.productCount} product${fetcher.data.productCount === 1 ? "" : "s"}`,
      );
      setIsModalOpen(false);
    }

    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const toggleProduct = (productId) => {
    setSelectedProductIds((current) =>
      current.includes(productId)
        ? current.filter((selectedProductId) => selectedProductId !== productId)
        : [...current, productId],
    );
  };

  const openRuleModal = () => {
    setSelectedProductIds([]);
    setRuleName("Pre-order rule");
    setDepositType("percentage");
    setDepositValue(20);
    setBalanceDueDays(30);
    setIsModalOpen(true);
  };

  const renderModalProductRow = (product) => (
    <label
      key={product.id}
      style={{
        alignItems: "center",
        borderBottom: "1px solid #e3e3e3",
        cursor: "pointer",
        display: "grid",
        gap: "12px",
        gridTemplateColumns: "auto 56px 1fr auto",
        minHeight: "80px",
        padding: "12px",
      }}
    >
      <input
        checked={selectedProductIds.includes(product.id)}
        onChange={() => toggleProduct(product.id)}
        type="checkbox"
        value={product.id}
      />
      {product.image ? (
        <img
          alt={product.image.altText || ""}
          height="56"
          src={product.image.url}
          style={{ borderRadius: "6px", objectFit: "cover" }}
          width="56"
        />
      ) : (
        <span
          style={{
            background: "#f1f1f1",
            borderRadius: "6px",
            display: "block",
            height: "56px",
            width: "56px",
          }}
        />
      )}
      <span>
        <strong>{product.title}</strong>
        <br />
        <span style={{ color: "#616161", fontSize: "13px" }}>
          {product.variant?.price ? `From ${product.variant.price}` : "No variant price"} - {product.status}
        </span>
      </span>
      <s-badge tone={product.settings?.active ? "success" : "neutral"}>
        {product.settings?.active ? "Pre-order on" : "Off"}
      </s-badge>
    </label>
  );

  return (
    <s-page heading="Pre-order products">
      <s-button slot="primary-action" onClick={openRuleModal} variant="primary">
        Create rule
      </s-button>

      <s-section>
        <div style={{ padding: "8px 0 20px", textAlign: "center" }}>
          <h1 style={{ fontSize: "28px", lineHeight: "36px", margin: 0 }}>
            Created for aniksanandco only
          </h1>
        </div>
      </s-section>

      <s-section heading="Rules">
        <s-stack gap="base">
          <s-paragraph>
            {rules.length} active pre-order rule{rules.length === 1 ? "" : "s"} across {activeProducts.length} product{activeProducts.length === 1 ? "" : "s"}.
          </s-paragraph>
          {rules.length === 0 ? (
            <s-box borderWidth="base" borderRadius="base" padding="base">
              <s-stack gap="base">
                <s-heading>No pre-order rules yet</s-heading>
                <s-paragraph>Create a rule to select products and set the deposit customers pay at checkout.</s-paragraph>
                <s-button onClick={openRuleModal} variant="primary">
                  Create rule
                </s-button>
              </s-stack>
            </s-box>
          ) : (
            <s-stack gap="base">
              {rules.map((rule) => {
                const productNames = rule.products.map((product) => product.title).join(", ");
                const hiddenProductCount = Math.max(rule.products.length - 3, 0);
                const visibleProductNames = rule.products
                  .slice(0, 3)
                  .map((product) => product.title)
                  .join(", ");
                const depositLabel =
                  rule.depositType === "percentage"
                    ? `${rule.depositValue}% deposit`
                    : `${Number(rule.depositValue).toFixed(2)} deposit`;

                return (
                  <div
                    key={rule.key}
                    style={{
                      border: "1px solid #e3e3e3",
                      borderRadius: "8px",
                      display: "grid",
                      gap: "12px",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      padding: "16px",
                    }}
                  >
                    <div>
                      <strong>{rule.ruleName}</strong>
                      <p style={{ color: "#616161", margin: "6px 0 0" }}>
                        {depositLabel}. Balance due after {rule.balanceDueDays} day{rule.balanceDueDays === 1 ? "" : "s"}.
                      </p>
                      <p title={productNames} style={{ color: "#616161", fontSize: "13px", margin: "8px 0 0" }}>
                        {visibleProductNames}
                        {hiddenProductCount > 0 ? ` and ${hiddenProductCount} more` : ""}
                      </p>
                    </div>
                    <div style={{ alignItems: "flex-end", display: "flex", flexDirection: "column", gap: "12px" }}>
                      <s-badge tone="success">
                        {rule.products.length} product{rule.products.length === 1 ? "" : "s"}
                      </s-badge>
                      <fetcher.Form
                        method="post"
                        onSubmit={(event) => {
                          if (!window.confirm(`Delete "${rule.ruleName}"? This removes the pre-order rule from ${rule.products.length} product${rule.products.length === 1 ? "" : "s"}.`)) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <input name="productIds" type="hidden" value={JSON.stringify(rule.products.map((product) => product.id))} />
                        <input name="ruleName" type="hidden" value={rule.ruleName} />
                        {rule.sellingPlanGroupId ? (
                          <input name="sellingPlanGroupId" type="hidden" value={rule.sellingPlanGroupId} />
                        ) : null}
                        <s-button
                          disabled={isSubmitting}
                          name="intent"
                          tone="critical"
                          type="submit"
                          value="delete"
                          variant="secondary"
                        >
                          Delete
                        </s-button>
                      </fetcher.Form>
                    </div>
                  </div>
                );
              })}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Theme setup">
        <s-paragraph>
          Add the Pre-order button app block to the product template. It only appears for products enabled here.
        </s-paragraph>
        <s-paragraph>
          Shopify may require protected purchase option scopes before deposits work on a live store.
        </s-paragraph>
      </s-section>

      {isModalOpen && (
        <div
          role="presentation"
          style={{
            alignItems: "center",
            background: "rgba(0, 0, 0, 0.42)",
            display: "flex",
            inset: 0,
            justifyContent: "center",
            padding: "24px",
            position: "fixed",
            zIndex: 1000,
          }}
        >
          <div
            aria-modal="true"
            role="dialog"
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              boxShadow: "0 24px 80px rgba(0, 0, 0, 0.22)",
              maxHeight: "90vh",
              maxWidth: "980px",
              overflow: "hidden",
              width: "100%",
            }}
          >
            <fetcher.Form method="post">
              <input name="productIds" type="hidden" value={JSON.stringify(selectedProductIds)} />
              {selectedProducts.map((product) => (
                <input key={product.id} name="productTitles" type="hidden" value={product.title} />
              ))}

              <div
                style={{
                  alignItems: "center",
                  borderBottom: "1px solid #e3e3e3",
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                }}
              >
                <div>
                  <h2 style={{ fontSize: "18px", lineHeight: "24px", margin: 0 }}>Create pre-order rule</h2>
                  <p style={{ color: "#616161", margin: "4px 0 0" }}>
                    Select products and set the deposit customers pay at checkout.
                  </p>
                </div>
                <button
                  aria-label="Close"
                  onClick={() => setIsModalOpen(false)}
                  style={{
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                    fontSize: "24px",
                    lineHeight: "24px",
                  }}
                  type="button"
                >
                  x
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gap: "20px",
                  gridTemplateColumns: "minmax(0, 1.3fr) minmax(280px, 0.7fr)",
                  maxHeight: "calc(90vh - 145px)",
                  overflow: "auto",
                  padding: "20px",
                }}
              >
                <div>
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: "12px",
                    }}
                  >
                    <strong>Select products</strong>
                    <label style={{ alignItems: "center", display: "flex", gap: "8px" }}>
                      <input
                        checked={allSelected}
                        onChange={() =>
                          setSelectedProductIds(allSelected ? [] : products.map((product) => product.id))
                        }
                        type="checkbox"
                      />
                      Select all
                    </label>
                  </div>
                  <div
                    style={{
                      border: "1px solid #e3e3e3",
                      borderRadius: "8px",
                      maxHeight: "520px",
                      overflow: "auto",
                    }}
                  >
                    {products.map((product) => renderModalProductRow(product))}
                  </div>
                </div>

                <s-stack gap="base">
                  <s-text-field
                    label="Rule name"
                    name="ruleName"
                    onChange={(event) => setRuleName(event.currentTarget.value)}
                    value={ruleName}
                  />
                  <s-select
                    label="Checkout charge"
                    name="depositType"
                    onChange={(event) => setDepositType(event.currentTarget.value)}
                    value={depositType}
                  >
                    <s-option value="percentage">Percentage of product price</s-option>
                    <s-option value="price">Fixed amount</s-option>
                  </s-select>
                  <s-number-field
                    label={depositType === "percentage" ? "Deposit percentage" : "Deposit amount"}
                    min="0"
                    name="depositValue"
                    onChange={(event) => setDepositValue(event.currentTarget.value)}
                    step={depositType === "percentage" ? "1" : "0.01"}
                    value={depositValue}
                  />
                  <s-number-field
                    label="Collect remaining balance after days"
                    min="1"
                    name="balanceDueDays"
                    onChange={(event) => setBalanceDueDays(event.currentTarget.value)}
                    step="1"
                    value={balanceDueDays}
                  />
                  <s-paragraph>
                    The selected products will share one Shopify pre-order selling plan.
                  </s-paragraph>
                </s-stack>
              </div>

              <div
                style={{
                  alignItems: "center",
                  borderTop: "1px solid #e3e3e3",
                  display: "flex",
                  gap: "12px",
                  justifyContent: "flex-end",
                  padding: "16px 20px",
                }}
              >
                <s-button disabled={isSubmitting} onClick={() => setIsModalOpen(false)} type="button">
                  Cancel
                </s-button>
                <s-button
                  disabled={selectedProductIds.length === 0 || isSubmitting}
                  name="intent"
                  type="submit"
                  value="disable"
                  variant="secondary"
                >
                  Disable selected
                </s-button>
                <s-button
                  disabled={selectedProductIds.length === 0 || isSubmitting}
                  {...(isSubmitting ? { loading: true } : {})}
                  type="submit"
                  variant="primary"
                >
                  Create rule
                </s-button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
