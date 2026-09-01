class InvoiceClient {
  fun covered() {
    RestTemplate.getForObject("/invoices/{id}", String::class.java)
  }

  // spacing to ensure >5 lines from covered fact at line 2
  fun missing() {
    RestTemplate.postForObject("/invoices", payload)
  }
  fun dynamic() {
    RestTemplate.getForObject("/invoices/" + param, String::class.java)
  }
}
