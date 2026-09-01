@FeignClient(name="billing")
public class BillingClient {
  @GetMapping(path = "/invoices/{id}")
  public void get() {}
  @GetMapping
  public void ambiguous() {}
}
