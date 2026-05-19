// Before
_ABI(SystemV_x86_64)
generic64_t f(generic64_t arg) {
  generic64_t v0;
  generic64_t v1;
  generic64_t v2;
  v0 = 0UL;
  if (arg) {
    v1 = g(arg);
    v2 = v1 ? v1 : arg;
    v0 = v2;
  }
  return v0;
}
