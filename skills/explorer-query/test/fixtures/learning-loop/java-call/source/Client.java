public class Client {
  public void call() {
    Gateway.fetch("42");
  }
  public void ambiguous() {
    Gateway.fetch();
  }
}
