"""Words of evaluated Smalltalk, from captured arguments."""

from pharo_agent_analytics import content


def test_classes_and_messages_of_a_snippet():
    code = '''| result |
"find the senders" result := (SystemNavigation default allSendersOf: #printString)
    collect: [:each | each methodClass name].
result asSortedCollection first: 3.
OrderedCollection new add: 'x, y'; yourself'''
    classes, messages = content.words(code)
    assert classes == {"SystemNavigation", "OrderedCollection"}
    assert messages == {"default", "allSendersOf:", "collect:", "methodClass", "name",
                        "asSortedCollection", "first:", "new", "add:", "yourself"}


def test_keyword_parts_make_one_message_across_nesting():
    classes, messages = content.words("Smalltalk at: #Foo put: (Dictionary new at: 1 put: 2; yourself)")
    assert messages == {"at:put:", "new", "yourself"}
    assert classes == {"Smalltalk", "Dictionary"}


def test_the_code_argument_or_every_string():
    assert content.code_of('{"code": "1 + 2", "timeoutSeconds": 5}') == "1 + 2"
    assert content.code_of('{"expression": "Object new"}') == "Object new"
    assert content.code_of(None) is None
