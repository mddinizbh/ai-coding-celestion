package main

import "fmt"

// Greeter greets callers.
type Greeter struct {
	Name string
}

// Greet returns a greeting.
func (g Greeter) Greet() string {
	return fmt.Sprintf("hello %s", g.Name)
}

func main() {
	g := Greeter{Name: "world"}
	fmt.Println(g.Greet())
}
