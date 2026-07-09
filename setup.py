from setuptools import setup, find_packages

with open("requirements.txt") as f:
	install_requires = f.read().strip().split("\n")

setup(
	name="telnyx_otp",
	version="0.1.0",
	description="Receives inbound SMS webhooks (Telnyx, relayed via n8n/Zoho Flow) and displays OTP codes in a live inbox, per-number, with used/expired tracking",
	author="Pestalozzi International",
	author_email="you@example.com",
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires,
)
