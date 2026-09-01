class EventBus {
  @KafkaListener(topics = ["orders"])
  fun consume() {}
  fun ambiguous() {
    KafkaTemplate.send(dynamicTopic, payload)
  }
}
