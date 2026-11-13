// Fixed legacy config/admin.php product_default_star and createSpu() shape.
// Generate only for a new product; existing rows retain their historical values.
export function productCreationDefaults() {
  return { star: '5.0', spu: [...crypto.getRandomValues(new Uint8Array(13))]
    .map(value => value % 10).join('') };
}
