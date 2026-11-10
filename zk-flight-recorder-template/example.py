"""Offline agent computation; scanner calls are live and consume prepaid credits."""
from langchain_core.runnables import RunnableLambda
from flight_recorder import DurableRecorder, langchain_callback


def main():
    with DurableRecorder.from_env() as recorder:
        # Replace with your existing LangChain agent. No model key needed for this example.
        agent = RunnableLambda(lambda inputs: {"result": inputs["message"].upper()})
        result = agent.invoke(
            {"message": "synthetic enterprise recorder integration example"},
            config={"callbacks": [langchain_callback(recorder)]},
        )
        print(result)  # Never print the recorder configuration or token.


if __name__ == "__main__":
    main()
