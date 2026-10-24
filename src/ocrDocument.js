// Keep parser-native fields for display, and expose one accounting amount.
// Salary uses net pay, never gross salary or deductions.
export function normalizeDocument(data, forcedType) {
  const type = forcedType || data.doc_type ||
    (Object.hasOwn(data, "net_pay") ? "payslip" : Object.hasOwn(data, "total") ? "receipt" : undefined);
  let amount = data.amount ?? null;
  if (type === "receipt" && Object.hasOwn(data, "total")) amount = data.total;
  if (type === "payslip" && Object.hasOwn(data, "net_pay")) amount = data.net_pay;
  return { ...data, ...(type ? { doc_type: type } : {}), amount };
}
