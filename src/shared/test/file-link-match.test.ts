import { expect, test } from "bun:test";
import { messageContainsFileLink } from "@/shared/file-link-match";

const PATH = "channels/general/notes.md";

test("labeled markdown links and bare path tokens match, substrings do not", () => {
  expect(messageContainsFileLink(`See [notes](${PATH})`, PATH)).toBe(true);
  expect(messageContainsFileLink(`See [notes](./${PATH}#intro)`, PATH)).toBe(
    true,
  );
  expect(messageContainsFileLink(`Look at ${PATH} please`, PATH)).toBe(true);
  expect(messageContainsFileLink(`Look at ./${PATH}`, PATH)).toBe(true);
  expect(
    messageContainsFileLink(`I copied ${PATH}.bak into the other folder`, PATH),
  ).toBe(false);
  expect(messageContainsFileLink("plain prose about notes.md", PATH)).toBe(
    false,
  );
  expect(
    messageContainsFileLink("https://example.com/channels/general/notes.md", PATH),
  ).toBe(false);
});

test("percent-encoded hrefs match the decoded workspace path", () => {
  expect(
    messageContainsFileLink(
      "See [report](channels/general/My%20Report.md)",
      "channels/general/My Report.md",
    ),
  ).toBe(true);
  expect(
    messageContainsFileLink(
      "See channels/general/My%20Report.md",
      "channels/general/My Report.md",
    ),
  ).toBe(true);
  expect(
    messageContainsFileLink(
      "See [readme](README.md)",
      "README.md",
    ),
  ).toBe(true);
  expect(
    messageContainsFileLink(
      "See [notes](channels/caf%c3%a9.md)",
      "channels/café.md",
    ),
  ).toBe(true);
});
