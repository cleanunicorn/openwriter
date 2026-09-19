Intro paragraph with an inline {{< ref "other.md" >}} shortcode.

{{< notice warning >}}
First paragraph inside.

- a list inside
- the shortcode

{{< /notice >}}

{{% details "Summary with >}} inside quotes" %}}
Markdown **inside** a percent shortcode.

{{< figure src="a.png" />}}

More text.
{{% /details %}}

{{< youtube dQw4w9WgXcQ >}}

The text `{{< notice >}}` in a code span is not a shortcode.

```go-html-template
{{< notice >}}
this fence must stay its own block
```

Closing paragraph.
