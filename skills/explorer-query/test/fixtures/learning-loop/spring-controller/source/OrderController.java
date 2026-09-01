public class OrderController {
  @GetMapping(path = "/orders/{id}")
  public void get() {}
  @RequestMapping("/orders")
  public void ambiguous() {}
}
